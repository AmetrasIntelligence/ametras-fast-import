import type { ParsedRow } from './csvParser'
import type { BatchResult } from './batchExecutor'
import { logger } from '@/utils/logger'

/**
 * A batch of rows ready for processing.
 */
export interface Batch {
  id: number
  rows: ParsedRow[]
  filename: string
}

/**
 * Result from processing a batch.
 */
export interface BatchProcessResult {
  batchId: number
  results: BatchResult[]
  rows: ParsedRow[]
  processingTimeMs: number
}

/**
 * Async queue with backpressure support.
 * Workers pull batches from the queue.
 */
export class AsyncQueue<T> {
  private items: T[] = []
  private resolvers: Array<(value: T | null) => void> = []
  private closed = false

  /**
   * Add an item to the queue.
   */
  push(item: T): void {
    if (this.closed) {
      throw new Error('Queue is closed')
    }

    // If there's a waiting consumer, give it directly
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver(item)
    } else {
      this.items.push(item)
    }
  }

  /**
   * Get the next item from the queue.
   * Returns null when queue is closed and empty.
   */
  async next(): Promise<T | null> {
    // If there are items, return immediately
    if (this.items.length > 0) {
      return this.items.shift()!
    }

    // If closed and empty, return null
    if (this.closed) {
      return null
    }

    // Wait for an item
    return new Promise((resolve) => {
      this.resolvers.push(resolve)
    })
  }

  /**
   * Close the queue. Waiting consumers will receive null.
   */
  close(): void {
    this.closed = true
    // Release all waiting consumers
    for (const resolver of this.resolvers) {
      resolver(null)
    }
    this.resolvers = []
  }

  /**
   * Check if queue is closed.
   */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Get current queue length.
   */
  get length(): number {
    return this.items.length
  }

  /**
   * Clear all items from the queue.
   */
  clear(): void {
    this.items = []
  }
}

/**
 * Worker pool for parallel batch processing.
 *
 * Key invariants:
 * - Files are processed sequentially (never parallel)
 * - Workers only process independent batches within a single file
 * - Retries are always serialized (workers = 1)
 * - Worker count is bounded (1-4)
 */
export class WorkerPool {
  private batchQueue = new AsyncQueue<Batch>()
  private workerCount: number
  private workers: Promise<void>[] = []
  private batchIdCounter = 0
  private activeWorkers = 0
  private processedBatches = 0
  private aborted = false
  private paused = false
  private pauseResolvers: Array<() => void> = []
  private pendingCallbacks: Promise<void>[] = []

  private onBatchComplete?: (result: BatchProcessResult) => void
  private processBatch?: (batch: Batch) => Promise<BatchResult[]>

  constructor(workerCount: number) {
    // Enforce bounds: 1-4 workers
    this.workerCount = Math.max(1, Math.min(4, workerCount))
  }

  /**
   * Start the worker pool.
   *
   * @param processBatch Function to process a single batch
   * @param onBatchComplete Callback when a batch completes
   */
  start(
    processBatch: (batch: Batch) => Promise<BatchResult[]>,
    onBatchComplete: (result: BatchProcessResult) => void
  ): void {
    this.processBatch = processBatch
    this.onBatchComplete = onBatchComplete
    this.aborted = false
    this.processedBatches = 0
    this.pendingCallbacks = []
    this.workers = []

    // Spawn workers
    for (let i = 0; i < this.workerCount; i++) {
      this.workers.push(this.workerLoop(i))
    }
  }

  /**
   * Add a batch to the processing queue.
   */
  enqueueBatch(rows: ParsedRow[], filename: string): number {
    const batchId = ++this.batchIdCounter
    this.batchQueue.push({ id: batchId, rows, filename })
    return batchId
  }

  /**
   * Signal that no more batches will be added for the current file.
   * Workers will finish processing remaining queued batches and then stop.
   *
   * No timeout — workers are bounded by the engine's AbortController which
   * is checked in retry loops and API calls. A fixed timeout would race
   * against legitimate long-running standalone retries.
   */
  async finishFile(): Promise<void> {
    this.batchQueue.close()

    // Wait for all workers to complete their loops
    await Promise.all(this.workers)

    // Drain pending callbacks in a loop: workers may have added callbacks
    // just before finishing, so we keep draining until stable.
    // Uses Promise.allSettled so individual callback failures are logged
    // without aborting the entire drain (other callbacks still run).
    while (this.pendingCallbacks.length > 0) {
      const batch = [...this.pendingCallbacks]
      this.pendingCallbacks = []
      const settled = await Promise.allSettled(batch)
      for (const result of settled) {
        if (result.status === 'rejected') {
          logger.worker.error('Batch callback failed during finishFile drain', {
            error: result.reason instanceof Error ? result.reason.message : String(result.reason)
          })
        }
      }
    }

    this.workers = []
    this.pendingCallbacks = []
    // Reset queue for next file
    this.batchQueue = new AsyncQueue<Batch>()
  }

  /**
   * Wait for all worker loops to settle after abort.
   * Call after abort() to ensure no orphaned workers remain in-flight.
   */
  async drain(): Promise<void> {
    await Promise.allSettled(this.workers)
  }

  /**
   * Abort all processing immediately.
   */
  abort(): void {
    this.aborted = true
    this.batchQueue.close()
    this.pendingCallbacks = []
    // Release any paused workers so they can exit
    this.resume()
  }

  /**
   * Pause processing. Workers will finish their current batch
   * and then wait until resumed.
   */
  pause(): void {
    this.paused = true
  }

  /**
   * Resume processing after pause.
   */
  resume(): void {
    this.paused = false
    // Release all waiting workers
    for (const resolve of this.pauseResolvers) {
      resolve()
    }
    this.pauseResolvers = []
  }

  /**
   * Check if currently paused.
   */
  get isPaused(): boolean {
    return this.paused
  }

  /**
   * Wait while paused. Returns immediately if not paused.
   * Uses a while loop so that if paused again between the resume signal
   * and the waiter actually running, we re-enter the wait correctly.
   * Public so the engine can also pause CSV streaming, not just workers.
   */
  async waitWhilePaused(): Promise<void> {
    while (this.paused) {
      await new Promise<void>((resolve) => {
        this.pauseResolvers.push(resolve)
      })
    }
  }

  /**
   * Get the number of currently active workers.
   */
  get activeWorkerCount(): number {
    return this.activeWorkers
  }

  /**
   * Get the number of processed batches.
   */
  get processedBatchCount(): number {
    return this.processedBatches
  }

  /**
   * Get pending batch count in queue.
   */
  get pendingBatchCount(): number {
    return this.batchQueue.length
  }

  /**
   * Internal worker loop.
   */
  private async workerLoop(workerId: number): Promise<void> {
    logger.worker.debug(`Worker ${workerId} started`)

    while (!this.aborted) {
      // Wait if paused
      await this.waitWhilePaused()
      if (this.aborted) break

      let batch: Batch | null = null

      try {
        batch = await this.batchQueue.next()
      } catch (error) {
        logger.worker.error(`Worker ${workerId}: Error getting next batch`, {
          error: error instanceof Error ? error.message : String(error)
        })
        break
      }

      // Queue closed and empty
      if (!batch) break

      // Check pause again after getting batch (in case paused while waiting)
      await this.waitWhilePaused()
      if (this.aborted) break

      // Process the batch
      this.activeWorkers++
      const startTime = Date.now()

      try {
        const results = await this.processBatch!(batch)

        if (!this.aborted) {
          this.processedBatches++
          const duration = Date.now() - startTime
          logger.worker.debug(`Worker ${workerId}: Batch ${batch.id} completed`, {
            rows: batch.rows.length,
            durationMs: duration
          })
          // Track callback as pending to ensure it completes before finishFile returns.
          // Errors are NOT caught here — they propagate to finishFile's drain loop
          // so progress update failures are visible instead of silently lost.
          const callbackPromise = Promise.resolve().then(() => {
            if (this.aborted) return
            this.onBatchComplete?.({
              batchId: batch.id,
              results,
              rows: batch.rows,
              processingTimeMs: duration
            })
          })
          this.pendingCallbacks.push(callbackPromise)
        }
      } catch (error) {
        logger.worker.error(`Worker ${workerId}: Error processing batch ${batch.id}`, {
          error: error instanceof Error ? error.message : String(error),
          rows: batch.rows.length
        })
        // On error, mark all rows as failed
        if (!this.aborted) {
          this.processedBatches++
          // Track error callback as pending
          const errorCallbackPromise = Promise.resolve().then(() => {
            if (this.aborted) return
            this.onBatchComplete?.({
              batchId: batch.id,
              results: batch.rows.map(row => ({
                ok: false,
                error: error instanceof Error ? error.message : 'Worker error',
                rowIndex: row.index
              })),
              rows: batch.rows,
              processingTimeMs: Date.now() - startTime
            })
          })
          this.pendingCallbacks.push(errorCallbackPromise)
        }
      } finally {
        this.activeWorkers--
      }
    }

    logger.worker.debug(`Worker ${workerId} stopped`)
  }
}

/**
 * Calculate optimal worker count based on batch size.
 * Warns if configuration is inefficient.
 */
export function validateWorkerConfig(
  workers: number,
  batchSize: number
): { valid: boolean; warning?: string } {
  if (workers > 2 && batchSize < 50) {
    return {
      valid: true,
      warning: 'Workers may be inefficient with small batch sizes (< 50 rows)'
    }
  }

  if (workers > 4) {
    return {
      valid: false,
      warning: 'Maximum 4 workers allowed'
    }
  }

  return { valid: true }
}

/**
 * Calculate throughput in rows per second.
 */
export function calculateThroughput(
  processedRows: number,
  elapsedMs: number,
  workers: number
): { rowsPerSecond: number; display: string } {
  if (elapsedMs === 0) {
    return { rowsPerSecond: 0, display: '-- rows/sec' }
  }

  const rowsPerSecond = Math.round((processedRows / elapsedMs) * 1000)

  return {
    rowsPerSecond,
    display: workers > 1
      ? `~${rowsPerSecond} rows/sec (${workers} workers)`
      : `~${rowsPerSecond} rows/sec`
  }
}
