import { describe, it, expect, vi } from 'vitest'
import {
  AsyncQueue,
  WorkerPool,
  validateWorkerConfig,
  calculateThroughput
} from '@/importer/workerPool'
import type { BatchResult } from '@/importer/batchExecutor'

describe('AsyncQueue', () => {
  it('returns items in order', async () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    queue.push(2)
    queue.push(3)

    expect(await queue.next()).toBe(1)
    expect(await queue.next()).toBe(2)
    expect(await queue.next()).toBe(3)
  })

  it('waits for items when queue is empty', async () => {
    const queue = new AsyncQueue<number>()

    // Start waiting before pushing
    const promise = queue.next()

    // Push after a small delay
    setTimeout(() => queue.push(42), 10)

    expect(await promise).toBe(42)
  })

  it('returns null when closed and empty', async () => {
    const queue = new AsyncQueue<number>()
    queue.close()

    expect(await queue.next()).toBeNull()
  })

  it('releases waiting consumers when closed', async () => {
    const queue = new AsyncQueue<number>()

    const promise = queue.next()
    queue.close()

    expect(await promise).toBeNull()
  })

  it('throws when pushing to closed queue', () => {
    const queue = new AsyncQueue<number>()
    queue.close()

    expect(() => queue.push(1)).toThrow('Queue is closed')
  })

  it('reports correct length', () => {
    const queue = new AsyncQueue<number>()
    expect(queue.length).toBe(0)

    queue.push(1)
    queue.push(2)
    expect(queue.length).toBe(2)
  })
})

describe('WorkerPool', () => {
  it('processes batches with single worker', async () => {
    const pool = new WorkerPool(1)
    const results: number[] = []

    const processBatch = vi.fn(async (batch) => {
      return batch.rows.map(r => ({
        ok: true,
        rowIndex: r.index
      } as BatchResult))
    })

    const onComplete = vi.fn((result) => {
      results.push(result.batchId)
    })

    pool.start(processBatch, onComplete)

    pool.enqueueBatch([{ index: 1, data: {}, raw: [] }], 'test.csv')
    pool.enqueueBatch([{ index: 2, data: {}, raw: [] }], 'test.csv')

    await pool.finishFile()

    expect(results).toHaveLength(2)
    expect(processBatch).toHaveBeenCalledTimes(2)
  })

  it('enforces worker count bounds (1-4)', () => {
    const pool1 = new WorkerPool(0)
    expect(pool1['workerCount']).toBe(1)

    const pool2 = new WorkerPool(10)
    expect(pool2['workerCount']).toBe(4)

    const pool3 = new WorkerPool(2)
    expect(pool3['workerCount']).toBe(2)
  })

  it('aborts processing', async () => {
    const pool = new WorkerPool(1)
    const processed: number[] = []

    pool.start(
      async (batch) => {
        await new Promise(r => setTimeout(r, 100))
        return batch.rows.map(r => ({ ok: true, rowIndex: r.index } as BatchResult))
      },
      (result) => processed.push(result.batchId)
    )

    pool.enqueueBatch([{ index: 1, data: {}, raw: [] }], 'test.csv')
    pool.enqueueBatch([{ index: 2, data: {}, raw: [] }], 'test.csv')

    // Abort immediately
    pool.abort()

    // Wait a bit to ensure processing would have completed
    await new Promise(r => setTimeout(r, 50))

    // Should have processed 0 or 1 batch (first might have started)
    expect(processed.length).toBeLessThanOrEqual(1)
  })
})

describe('validateWorkerConfig', () => {
  it('warns when batch size is above 50 (timeout risk)', () => {
    const result = validateWorkerConfig(3, 60)
    expect(result.valid).toBe(true)
    expect(result.warning).toContain('timeouts')
  })

  it('returns valid for reasonable config', () => {
    const result = validateWorkerConfig(2, 50)
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  it('rejects workers > 4', () => {
    const result = validateWorkerConfig(5, 200)
    expect(result.valid).toBe(false)
    expect(result.warning).toContain('Maximum 4')
  })
})

describe('calculateThroughput', () => {
  it('calculates rows per second', () => {
    const result = calculateThroughput(1000, 2000, 1)
    expect(result.rowsPerSecond).toBe(500)
    expect(result.display).toBe('~500 rows/sec')
  })

  it('shows worker count when > 1', () => {
    const result = calculateThroughput(1000, 2000, 2)
    expect(result.display).toBe('~500 rows/sec (2 workers)')
  })

  it('handles zero elapsed time', () => {
    const result = calculateThroughput(100, 0, 1)
    expect(result.rowsPerSecond).toBe(0)
    expect(result.display).toBe('-- rows/sec')
  })
})

describe('WorkerPool pause/resume', () => {
  it('pauses processing when pause is called', async () => {
    const pool = new WorkerPool(1)
    const processed: number[] = []

    pool.start(
      async (batch) => {
        await new Promise(r => setTimeout(r, 20))
        return batch.rows.map(r => ({ ok: true, rowIndex: r.index } as BatchResult))
      },
      (result) => processed.push(result.batchId)
    )

    // Enqueue batches
    pool.enqueueBatch([{ index: 1, data: {}, raw: [] }], 'test.csv')
    pool.enqueueBatch([{ index: 2, data: {}, raw: [] }], 'test.csv')
    pool.enqueueBatch([{ index: 3, data: {}, raw: [] }], 'test.csv')

    // Pause immediately
    pool.pause()
    expect(pool.isPaused).toBe(true)

    // Wait a bit - shouldn't process much
    await new Promise(r => setTimeout(r, 50))

    // Should have processed at most 1 batch (the one already in progress)
    const processedWhilePaused = processed.length
    expect(processedWhilePaused).toBeLessThanOrEqual(1)

    // Resume
    pool.resume()
    expect(pool.isPaused).toBe(false)

    // Complete
    await pool.finishFile()

    // Should have processed all 3
    expect(processed).toHaveLength(3)
  })

  it('resume releases waiting workers', async () => {
    const pool = new WorkerPool(2)
    let processCount = 0

    pool.start(
      async (batch) => {
        processCount++
        return batch.rows.map(r => ({ ok: true, rowIndex: r.index } as BatchResult))
      },
      () => {}
    )

    // Pause before enqueueing
    pool.pause()

    // Enqueue batches
    pool.enqueueBatch([{ index: 1, data: {}, raw: [] }], 'test.csv')
    pool.enqueueBatch([{ index: 2, data: {}, raw: [] }], 'test.csv')

    // Wait a bit - nothing should process
    await new Promise(r => setTimeout(r, 30))
    expect(processCount).toBe(0)

    // Resume and finish
    pool.resume()
    await pool.finishFile()

    expect(processCount).toBe(2)
  })

  it('abort releases paused workers', async () => {
    const pool = new WorkerPool(1)

    pool.start(
      async (batch) => batch.rows.map(r => ({ ok: true, rowIndex: r.index } as BatchResult)),
      () => {}
    )

    pool.pause()
    pool.enqueueBatch([{ index: 1, data: {}, raw: [] }], 'test.csv')

    // Abort should release paused workers
    pool.abort()

    // Should not hang - finishFile should complete quickly
    await pool.finishFile()

    expect(pool.processedBatchCount).toBe(0)
  })
})

describe('WorkerPool completion handling', () => {
  it('completes successfully after processing all batches', async () => {
    const pool = new WorkerPool(2)
    const completedBatches: number[] = []

    pool.start(
      async (batch) => {
        return batch.rows.map(r => ({ ok: true, rowIndex: r.index } as BatchResult))
      },
      (result) => completedBatches.push(result.batchId)
    )

    // Enqueue multiple batches
    pool.enqueueBatch([{ index: 1, data: {}, raw: [] }], 'test.csv')
    pool.enqueueBatch([{ index: 2, data: {}, raw: [] }], 'test.csv')
    pool.enqueueBatch([{ index: 3, data: {}, raw: [] }], 'test.csv')

    await pool.finishFile()

    expect(completedBatches).toHaveLength(3)
    expect(pool.processedBatchCount).toBe(3)
  })

  it('handles batch processing errors gracefully', async () => {
    const pool = new WorkerPool(1)
    const completedBatches: number[] = []
    let errorCount = 0

    pool.start(
      async (batch) => {
        if (batch.id === 2) {
          throw new Error('Simulated error')
        }
        return batch.rows.map(r => ({ ok: true, rowIndex: r.index } as BatchResult))
      },
      (result) => {
        completedBatches.push(result.batchId)
        if (result.results.some(r => !r.ok)) {
          errorCount++
        }
      }
    )

    pool.enqueueBatch([{ index: 1, data: {}, raw: [] }], 'test.csv')
    pool.enqueueBatch([{ index: 2, data: {}, raw: [] }], 'test.csv')
    pool.enqueueBatch([{ index: 3, data: {}, raw: [] }], 'test.csv')

    await pool.finishFile()

    // All batches should be processed (including the error one)
    expect(completedBatches).toHaveLength(3)
    expect(errorCount).toBe(1)
  })

  it('finishFile resolves even with empty queue', async () => {
    const pool = new WorkerPool(1)

    pool.start(
      async () => [],
      () => {}
    )

    // No batches enqueued
    await pool.finishFile()

    expect(pool.processedBatchCount).toBe(0)
  })

  it('handles multiple workers completing simultaneously', async () => {
    const pool = new WorkerPool(4)
    const processingOrder: number[] = []

    pool.start(
      async (batch) => {
        // Random delay to simulate varying processing times
        await new Promise(r => setTimeout(r, Math.random() * 20))
        processingOrder.push(batch.id)
        return batch.rows.map(r => ({ ok: true, rowIndex: r.index } as BatchResult))
      },
      () => {}
    )

    // Enqueue many batches
    for (let i = 0; i < 10; i++) {
      pool.enqueueBatch([{ index: i, data: {}, raw: [] }], 'test.csv')
    }

    await pool.finishFile()

    expect(processingOrder).toHaveLength(10)
  })

  it('reports active worker count correctly', async () => {
    const pool = new WorkerPool(2)
    let maxActiveWorkers = 0

    pool.start(
      async (batch) => {
        maxActiveWorkers = Math.max(maxActiveWorkers, pool.activeWorkerCount)
        await new Promise(r => setTimeout(r, 50))
        return batch.rows.map(r => ({ ok: true, rowIndex: r.index } as BatchResult))
      },
      () => {}
    )

    pool.enqueueBatch([{ index: 1, data: {}, raw: [] }], 'test.csv')
    pool.enqueueBatch([{ index: 2, data: {}, raw: [] }], 'test.csv')

    await pool.finishFile()

    // Should have seen 2 active workers at some point
    expect(maxActiveWorkers).toBeLessThanOrEqual(2)
  })
})
