/**
 * Simple async mutex for serializing state mutations.
 * Prevents concurrent updates from worker callbacks causing race conditions.
 */
export class StateLock {
  private locked = false
  private queue: Array<() => void> = []

  /** Maximum time in ms to wait for the lock before giving up. */
  private timeoutMs: number
  /** Maximum number of waiters allowed in the queue. */
  private maxQueueSize: number

  constructor(options?: { timeoutMs?: number; maxQueueSize?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 30_000  // 30s default
    this.maxQueueSize = options?.maxQueueSize ?? 100
  }

  /**
   * Acquire the lock. Returns a release function.
   * If lock is held, waits in queue until available.
   * Throws if timeout is exceeded or queue is full.
   */
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true
      return () => this.release()
    }

    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(`StateLock queue full (${this.maxQueueSize} waiters). Possible deadlock.`)
    }

    // Wait in queue with timeout
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter from the queue on timeout
        const idx = this.queue.indexOf(grant)
        if (idx !== -1) this.queue.splice(idx, 1)
        reject(new Error(`StateLock acquisition timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      const grant = () => {
        clearTimeout(timer)
        resolve(() => this.release())
      }

      this.queue.push(grant)
    })
  }

  private release(): void {
    if (this.queue.length > 0) {
      // Give lock to next waiter
      const next = this.queue.shift()!
      next()
    } else {
      this.locked = false
    }
  }

  /**
   * Execute a function with exclusive lock.
   * Automatically acquires and releases the lock.
   */
  async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * Forcefully reset the lock, clearing all waiters.
   * Use between import runs to prevent deadlocks from stale locks.
   */
  reset(): void {
    this.locked = false
    this.queue = []
  }

  /**
   * Check if lock is currently held.
   */
  get isLocked(): boolean {
    return this.locked
  }

  /**
   * Get number of waiters in queue.
   */
  get queueLength(): number {
    return this.queue.length
  }
}

/**
 * Global state lock for run store mutations.
 * Used by engine and worker pool to prevent concurrent state updates.
 */
export const runStateLock = new StateLock()
