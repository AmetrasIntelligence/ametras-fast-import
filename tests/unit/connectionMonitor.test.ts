import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConnectionMonitor, type HealthCheckFn } from '@/importer/connectionMonitor'

// Suppress logger output in tests
vi.mock('@/utils/logger', () => ({
  logger: {
    import: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    debug: vi.fn(),
  },
}))

describe('ConnectionMonitor', () => {
  let monitor: ConnectionMonitor

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    monitor?.destroy()
    vi.useRealTimers()
  })

  describe('initial state', () => {
    it('starts with online status', () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(true))
      expect(monitor.status).toBe('online')
    })
  })

  describe('reportOffline', () => {
    it('transitions to offline status', () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      monitor.reportOffline()
      expect(monitor.status).toBe('offline')
    })

    it('notifies listeners of status change', () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      const listener = vi.fn()
      monitor.onStatusChange(listener)

      monitor.reportOffline()
      expect(listener).toHaveBeenCalledWith('offline')
    })

    it('is a no-op if already offline', () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      const listener = vi.fn()

      monitor.reportOffline()
      monitor.onStatusChange(listener)
      monitor.reportOffline() // second call should be ignored
      expect(listener).not.toHaveBeenCalled()
    })

    it('schedules health check polling', async () => {
      const healthCheck = vi.fn().mockResolvedValue(false)
      monitor = new ConnectionMonitor(healthCheck)

      monitor.reportOffline()
      // First backoff is 1000ms
      await vi.advanceTimersByTimeAsync(1000)

      expect(healthCheck).toHaveBeenCalledTimes(1)
    })
  })

  describe('reportOnline', () => {
    it('transitions to online status', () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      monitor.reportOffline()
      monitor.reportOnline()
      expect(monitor.status).toBe('online')
    })

    it('is a no-op if already online', () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(true))
      const listener = vi.fn()
      monitor.onStatusChange(listener)

      monitor.reportOnline() // already online, should be ignored
      expect(listener).not.toHaveBeenCalled()
    })

    it('resolves pending waiters', async () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      monitor.reportOffline()

      const waiterResolved = vi.fn()
      monitor.waitForConnection().then(waiterResolved)

      // Waiter should not be resolved yet
      await vi.advanceTimersByTimeAsync(0)
      expect(waiterResolved).not.toHaveBeenCalled()

      // Report online should resolve the waiter
      monitor.reportOnline()
      await vi.advanceTimersByTimeAsync(0)
      expect(waiterResolved).toHaveBeenCalled()
    })

    it('cancels pending health check poll', async () => {
      const healthCheck = vi.fn().mockResolvedValue(false)
      monitor = new ConnectionMonitor(healthCheck)

      monitor.reportOffline()
      // Report online before the first health check fires
      monitor.reportOnline()

      await vi.advanceTimersByTimeAsync(5000)
      expect(healthCheck).not.toHaveBeenCalled()
    })
  })

  describe('waitForConnection', () => {
    it('resolves immediately if already online', async () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(true))
      await expect(monitor.waitForConnection()).resolves.toBeUndefined()
    })

    it('waits until server comes back online', async () => {
      let checkCount = 0
      const healthCheck = vi.fn().mockImplementation(async () => {
        checkCount++
        return checkCount >= 3 // Online on 3rd check
      })
      monitor = new ConnectionMonitor(healthCheck)
      monitor.reportOffline()

      const resolved = vi.fn()
      monitor.waitForConnection().then(resolved)

      // 1st check at 1000ms — still offline
      await vi.advanceTimersByTimeAsync(1000)
      expect(resolved).not.toHaveBeenCalled()

      // 2nd check at 1000+2000=3000ms — still offline
      await vi.advanceTimersByTimeAsync(2000)
      expect(resolved).not.toHaveBeenCalled()

      // 3rd check at 3000+4000=7000ms — online!
      await vi.advanceTimersByTimeAsync(4000)
      expect(resolved).toHaveBeenCalled()
    })

    it('rejects immediately if abort signal is already aborted', async () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      monitor.reportOffline()

      const controller = new AbortController()
      controller.abort()

      await expect(monitor.waitForConnection(controller.signal)).rejects.toThrow('Aborted')
    })

    it('rejects when abort signal fires during wait', async () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      monitor.reportOffline()

      const controller = new AbortController()
      const promise = monitor.waitForConnection(controller.signal)

      controller.abort()
      await expect(promise).rejects.toThrow('Aborted')
    })
  })

  describe('health check polling with backoff', () => {
    it('uses exponential backoff schedule', async () => {
      const healthCheck = vi.fn().mockResolvedValue(false)
      monitor = new ConnectionMonitor(healthCheck)
      monitor.reportOffline()

      // Backoff: 1000, 2000, 4000, 8000, 16000, 30000
      await vi.advanceTimersByTimeAsync(1000) // 1st check
      expect(healthCheck).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2000) // 2nd check
      expect(healthCheck).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(4000) // 3rd check
      expect(healthCheck).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(8000) // 4th check
      expect(healthCheck).toHaveBeenCalledTimes(4)
    })

    it('caps backoff at 30 seconds', async () => {
      const healthCheck = vi.fn().mockResolvedValue(false)
      monitor = new ConnectionMonitor(healthCheck)
      monitor.reportOffline()

      // Advance through all backoff steps: 1+2+4+8+16+30 = 61s
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(4000)
      await vi.advanceTimersByTimeAsync(8000)
      await vi.advanceTimersByTimeAsync(16000)
      await vi.advanceTimersByTimeAsync(30000) // 6th check, now at cap
      expect(healthCheck).toHaveBeenCalledTimes(6)

      // Next check should also be 30s (cap)
      await vi.advanceTimersByTimeAsync(30000)
      expect(healthCheck).toHaveBeenCalledTimes(7)
    })

    it('transitions to checking during health check', async () => {
      let resolveCheck: () => void
      const healthCheck = vi.fn().mockImplementation(() =>
        new Promise<boolean>(resolve => { resolveCheck = () => resolve(false) })
      )
      monitor = new ConnectionMonitor(healthCheck)

      const statuses: string[] = []
      monitor.onStatusChange(s => statuses.push(s))

      monitor.reportOffline()
      await vi.advanceTimersByTimeAsync(1000) // Triggers health check

      expect(statuses).toContain('checking')

      resolveCheck!()
      await vi.advanceTimersByTimeAsync(0) // Let promise resolve

      // After failed check, back to offline
      expect(monitor.status).toBe('offline')
    })

    it('resolves waiters when health check succeeds', async () => {
      let callCount = 0
      const healthCheck = vi.fn().mockImplementation(async () => ++callCount >= 2)
      monitor = new ConnectionMonitor(healthCheck)
      monitor.reportOffline()

      const resolved = vi.fn()
      monitor.waitForConnection().then(resolved)

      // 1st check fails
      await vi.advanceTimersByTimeAsync(1000)
      expect(resolved).not.toHaveBeenCalled()

      // 2nd check succeeds
      await vi.advanceTimersByTimeAsync(2000)
      expect(resolved).toHaveBeenCalled()
      expect(monitor.status).toBe('online')
    })
  })

  describe('onStatusChange', () => {
    it('returns an unsubscribe function', () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      const listener = vi.fn()
      const unsub = monitor.onStatusChange(listener)

      monitor.reportOffline()
      expect(listener).toHaveBeenCalledTimes(1)

      unsub()
      monitor.reportOnline()
      monitor.reportOffline()
      expect(listener).toHaveBeenCalledTimes(1) // no additional calls
    })

    it('handles listener errors gracefully', () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      const errorListener = vi.fn().mockImplementation(() => { throw new Error('listener error') })
      const goodListener = vi.fn()

      monitor.onStatusChange(errorListener)
      monitor.onStatusChange(goodListener)

      // Should not throw, and both listeners should be called
      expect(() => monitor.reportOffline()).not.toThrow()
      expect(errorListener).toHaveBeenCalled()
      expect(goodListener).toHaveBeenCalled()
    })
  })

  describe('destroy', () => {
    it('rejects pending waiters with destroy error', async () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      monitor.reportOffline()

      const promise = monitor.waitForConnection()
      monitor.destroy()

      await expect(promise).rejects.toThrow('ConnectionMonitor destroyed')
    })

    it('prevents further status changes', () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      monitor.destroy()

      monitor.reportOffline()
      expect(monitor.status).toBe('online') // unchanged
    })

    it('cancels pending polls', async () => {
      const healthCheck = vi.fn().mockResolvedValue(false)
      monitor = new ConnectionMonitor(healthCheck)
      monitor.reportOffline()
      monitor.destroy()

      await vi.advanceTimersByTimeAsync(60000)
      expect(healthCheck).not.toHaveBeenCalled()
    })

    it('clears listeners', () => {
      monitor = new ConnectionMonitor(() => Promise.resolve(false))
      const listener = vi.fn()
      monitor.onStatusChange(listener)
      monitor.destroy()

      // Create a new monitor to test the old listener is disconnected
      // (listeners.clear() was called in destroy)
      // We can't directly test this, but we can verify no errors
    })
  })

  describe('custom health check function', () => {
    it('uses the provided health check function', async () => {
      const customCheck = vi.fn().mockResolvedValue(true)
      monitor = new ConnectionMonitor(customCheck)
      monitor.reportOffline()

      await vi.advanceTimersByTimeAsync(1000)
      expect(customCheck).toHaveBeenCalled()
      expect(monitor.status).toBe('online')
    })

    it('handles health check function errors gracefully', async () => {
      const failingCheck = vi.fn().mockRejectedValue(new Error('check error'))
      monitor = new ConnectionMonitor(failingCheck)
      monitor.reportOffline()

      await vi.advanceTimersByTimeAsync(1000)
      // Should not throw, should remain offline
      expect(monitor.status).toBe('offline')
      expect(failingCheck).toHaveBeenCalled()
    })
  })
})
