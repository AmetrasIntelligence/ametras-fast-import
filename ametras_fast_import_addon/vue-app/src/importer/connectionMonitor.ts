import { logger } from '@/utils/logger'

export type ConnectionStatus = 'online' | 'offline' | 'checking'

type StatusListener = (status: ConnectionStatus) => void

/**
 * Health check function type.
 * Must return true if the server is reachable, false otherwise.
 */
export type HealthCheckFn = () => Promise<boolean>

/** Backoff schedule in ms: 1s, 2s, 4s, 8s, 16s, 30s (cap) */
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000]
const HEALTH_CHECK_TIMEOUT = 5000

/**
 * Default health check: POST to /ametras_fast_import/info (same-origin, embedded mode).
 */
async function defaultHealthCheck(): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT)
  try {
    const response = await fetch('/ametras_fast_import/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {}, id: Date.now() }),
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Monitors server connectivity and polls with exponential backoff
 * when the connection is lost. Resolves waiters when the server is reachable again.
 */
export class ConnectionMonitor {
  private _status: ConnectionStatus = 'online'
  private listeners = new Set<StatusListener>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private backoffIndex = 0
  private waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
  private destroyed = false
  private healthCheckFn: HealthCheckFn
  /** Timestamp of last reportOnline() — used to detect rapid offline→online→offline cycling. */
  private lastOnlineAt = 0

  constructor(healthCheckFn?: HealthCheckFn) {
    this.healthCheckFn = healthCheckFn ?? defaultHealthCheck
  }

  get status(): ConnectionStatus {
    return this._status
  }

  /** Called when a network error is detected — starts health check polling. */
  reportOffline(): void {
    if (this.destroyed || this._status === 'offline') return

    // Only reset backoff if we've been online for a meaningful duration (>5s).
    // This prevents a livelock when auth is rate-limited: the server is
    // reachable (health check passes) but batches fail immediately with
    // AUTH_ERROR, causing rapid offline→online→offline cycling.  Without
    // this guard, backoff resets to 0 each cycle, producing ~300 pings in
    // 5 minutes.  With escalating backoff the load drops to ~25.
    const onlineDuration = Date.now() - this.lastOnlineAt
    if (onlineDuration > 5000) {
      this.backoffIndex = 0
    }
    this.setStatus('offline')
    this.scheduleHealthCheck()
  }

  /** Called when a request succeeds — cancels polling and resolves waiters. */
  reportOnline(): void {
    if (this.destroyed || this._status === 'online') return

    this.cancelPoll()
    this.lastOnlineAt = Date.now()
    this.backoffIndex = 0
    this.setStatus('online')
    this.resolveAllWaiters()
  }

  /**
   * Returns a Promise that resolves when the server is back online.
   * If already online, resolves immediately.
   */
  waitForConnection(abortSignal?: AbortSignal): Promise<void> {
    if (this._status === 'online') return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(new Error('Aborted'))
        return
      }

      const waiter = { resolve, reject }
      this.waiters.push(waiter)

      if (abortSignal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter)
          if (idx !== -1) this.waiters.splice(idx, 1)
          reject(new Error('Aborted'))
        }
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatusChange(fn: StatusListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Clean up timers and reject pending waiters. */
  destroy(): void {
    this.destroyed = true
    this.cancelPoll()
    // Reject all pending waiters
    for (const waiter of this.waiters) {
      waiter.reject(new Error('ConnectionMonitor destroyed'))
    }
    this.waiters = []
    this.listeners.clear()
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status
    for (const fn of this.listeners) {
      try { fn(status) } catch { /* listener error */ }
    }
  }

  private resolveAllWaiters(): void {
    const pending = this.waiters
    this.waiters = []
    for (const waiter of pending) {
      waiter.resolve()
    }
  }

  private cancelPoll(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  private scheduleHealthCheck(): void {
    if (this.destroyed) return

    const delay = BACKOFF_STEPS[Math.min(this.backoffIndex, BACKOFF_STEPS.length - 1)]
    logger.import.info(`[ConnectionMonitor] Next health check in ${delay}ms (attempt ${this.backoffIndex + 1})`)

    this.pollTimer = setTimeout(() => this.performHealthCheck(), delay)
  }

  private async performHealthCheck(): Promise<void> {
    if (this.destroyed) return

    this.setStatus('checking')

    try {
      const isReachable = await this.healthCheckFn()

      if (isReachable) {
        logger.import.info('[ConnectionMonitor] Server is back online')
        this.backoffIndex = 0
        this.setStatus('online')
        this.resolveAllWaiters()
        return
      }
    } catch {
      // Still offline
    }

    if (this.destroyed) return

    // Still offline — try again with more backoff
    this.backoffIndex++
    this.setStatus('offline')
    this.scheduleHealthCheck()
  }
}
