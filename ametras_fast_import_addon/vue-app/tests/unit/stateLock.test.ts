import { describe, it, expect, vi } from 'vitest'
import { StateLock } from '@/utils/stateLock'

// Background:
// `runStateLock` is an exported singleton intended to serialize state mutations
// between concurrent workers. Today it is not imported anywhere outside its
// definition file, but it has been the source of "stuck import" bugs in the
// past — when the lock was acquired but never released, no subsequent import
// could start. These tests pin down the contract so that if anyone re-wires
// it into the run flow, the release-on-throw and reset-drains-waiters
// invariants stay intact.

describe('StateLock', () => {
  it('starts unlocked with an empty queue', () => {
    const lock = new StateLock()
    expect(lock.isLocked).toBe(false)
    expect(lock.queueLength).toBe(0)
  })

  describe('acquire / release', () => {
    it('grants the lock immediately when free', async () => {
      const lock = new StateLock()
      const release = await lock.acquire()
      expect(lock.isLocked).toBe(true)
      release()
      expect(lock.isLocked).toBe(false)
    })

    it('queues waiters and grants in FIFO order', async () => {
      const lock = new StateLock()
      const first = await lock.acquire()

      const order: number[] = []
      const w1 = lock.acquire().then(r => { order.push(1); return r })
      const w2 = lock.acquire().then(r => { order.push(2); return r })
      const w3 = lock.acquire().then(r => { order.push(3); return r })

      // All three are queued behind `first`.
      // queueLength is observed after a microtask yields so the awaits hit the queue.
      await Promise.resolve()
      expect(lock.queueLength).toBe(3)

      first()
      const r1 = await w1
      expect(order).toEqual([1])
      r1()
      const r2 = await w2
      expect(order).toEqual([1, 2])
      r2()
      const r3 = await w3
      expect(order).toEqual([1, 2, 3])
      r3()

      expect(lock.isLocked).toBe(false)
      expect(lock.queueLength).toBe(0)
    })

    it('release is idempotent — calling release() twice does not over-release', async () => {
      const lock = new StateLock()
      const release = await lock.acquire()
      release()
      // A second release on the same handle should not corrupt internal state
      // by accidentally granting the lock to a future caller while it is also
      // "free" — calling the returned function twice is a programmer error,
      // but it must be observable rather than catastrophic.
      release()
      expect(lock.isLocked).toBe(false)
      // Subsequent acquire must still work.
      const r2 = await lock.acquire()
      expect(lock.isLocked).toBe(true)
      r2()
    })
  })

  describe('withLock — try/finally guarantees release', () => {
    it('releases after the body resolves', async () => {
      const lock = new StateLock()
      const result = await lock.withLock(() => 42)
      expect(result).toBe(42)
      expect(lock.isLocked).toBe(false)
    })

    it('releases after the body throws synchronously', async () => {
      const lock = new StateLock()
      await expect(
        lock.withLock(() => { throw new Error('boom') })
      ).rejects.toThrow('boom')
      expect(lock.isLocked).toBe(false)

      // Next acquire must succeed — this is the regression guard for
      // "stuck imports" caused by a lock leak.
      const r = await lock.acquire()
      expect(lock.isLocked).toBe(true)
      r()
    })

    it('releases after the body rejects asynchronously', async () => {
      const lock = new StateLock()
      await expect(
        lock.withLock(async () => {
          await Promise.resolve()
          throw new Error('async boom')
        })
      ).rejects.toThrow('async boom')
      expect(lock.isLocked).toBe(false)

      // Pending waiter must be granted, not stranded.
      const release = await lock.acquire()
      release()
    })

    it('serializes concurrent withLock callers — no interleaving', async () => {
      const lock = new StateLock()
      const events: string[] = []

      const job = (name: string) => lock.withLock(async () => {
        events.push(`${name}:start`)
        await new Promise(r => setTimeout(r, 5))
        events.push(`${name}:end`)
      })

      await Promise.all([job('a'), job('b'), job('c')])

      // For each job, end must come right after its own start (no interleaving).
      expect(events).toEqual([
        'a:start', 'a:end',
        'b:start', 'b:end',
        'c:start', 'c:end',
      ])
      expect(lock.isLocked).toBe(false)
    })
  })

  describe('reset — drains waiters without deadlock', () => {
    it('resolves every pending acquire() so no promise hangs forever', async () => {
      const lock = new StateLock()
      const held = await lock.acquire()

      const w1 = lock.acquire()
      const w2 = lock.acquire()
      const w3 = lock.acquire()
      await Promise.resolve()
      expect(lock.queueLength).toBe(3)

      // Critical: reset() while holding the lock must drain all waiters.
      // This is the API that lets a new import start cleanly after the
      // previous one wedged for any reason.
      lock.reset()

      // All three promises must settle (not hang) within the next microtask cycle.
      await expect(
        Promise.race([
          Promise.all([w1, w2, w3]),
          new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 100)),
        ])
      ).resolves.toBeDefined()

      expect(lock.isLocked).toBe(false)
      expect(lock.queueLength).toBe(0)

      // The previously-held release handle is now a no-op — but calling it
      // must NOT relock or corrupt state.
      held()
      expect(lock.isLocked).toBe(false)

      // The lock is fully usable for the next consumer.
      const r = await lock.acquire()
      expect(lock.isLocked).toBe(true)
      r()
    })

    it('reset() on an idle lock is a safe no-op', () => {
      const lock = new StateLock()
      expect(() => lock.reset()).not.toThrow()
      expect(lock.isLocked).toBe(false)
      expect(lock.queueLength).toBe(0)
    })
  })

  describe('timeouts and queue limits', () => {
    it('rejects acquire() after timeoutMs and removes the waiter from the queue', async () => {
      vi.useFakeTimers()
      try {
        const lock = new StateLock({ timeoutMs: 100 })
        const held = await lock.acquire()

        const w = lock.acquire()
        await Promise.resolve()
        expect(lock.queueLength).toBe(1)

        vi.advanceTimersByTime(150)
        await expect(w).rejects.toThrow(/timed out/i)
        expect(lock.queueLength).toBe(0)

        held()
      } finally {
        vi.useRealTimers()
      }
    })

    it('throws synchronously when the queue is full', async () => {
      const lock = new StateLock({ maxQueueSize: 2, timeoutMs: 10_000 })
      const held = await lock.acquire()

      // Two waiters fill the queue
      const w1 = lock.acquire()
      const w2 = lock.acquire()
      await Promise.resolve()
      expect(lock.queueLength).toBe(2)

      // Third waiter must be rejected because the queue is full
      await expect(lock.acquire()).rejects.toThrow(/queue full/i)

      held()
      const r1 = await w1
      r1()
      const r2 = await w2
      r2()
    })
  })

})
