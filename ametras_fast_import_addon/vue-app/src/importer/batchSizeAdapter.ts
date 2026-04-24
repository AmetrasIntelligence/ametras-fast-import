/**
 * Adaptive batch size controller.
 * Shared between addon and standalone modes.
 *
 * Starts at the middle level (typically 10 rows) as a tradeoff:
 * - Not too small: only ~3 batches to ramp up to max on good data
 * - Not too large: a failed batch of 10 triggers fewer retry requests
 *   than a failed batch of 100
 *
 * Levels: [1, min(10, max), max] — starts at level 1 (middle).
 * Increase: after 30 consecutive successful rows, step up one level.
 * Decrease: after 3 consecutive concurrency failures, step down one level.
 * Timeout: immediately step down one level.
 */
export class BatchSizeAdapter {
  currentSize: number
  private levels: number[]
  private levelIndex: number
  private successfulRows: number = 0
  private consecutiveFailures: number = 0

  static readonly SUCCESS_THRESHOLD = 30
  static readonly FAILURE_THRESHOLD = 3

  constructor(maxSize: number = 100) {
    // Build levels: [1, min(10, max), max] deduplicated
    const raw = [1, Math.min(10, maxSize), maxSize]
    this.levels = [...new Set(raw)].sort((a, b) => a - b)
    // Start at middle level — balances warmup cost vs failed-batch cost
    this.levelIndex = Math.min(1, this.levels.length - 1)
    this.currentSize = this.levels[this.levelIndex]
  }

  /** Record successful rows and step back up after recovery from a step-down. */
  recordSuccess(rowCount: number): void {
    this.consecutiveFailures = 0
    if (this.levelIndex >= this.levels.length - 1) return // already at max
    this.successfulRows += rowCount
    if (this.successfulRows >= BatchSizeAdapter.SUCCESS_THRESHOLD) {
      this.levelIndex++
      this.currentSize = this.levels[this.levelIndex]
      this.successfulRows = 0
    }
  }

  /** Record a batch failure and step down after enough consecutive failures. */
  recordFailure(): void {
    this.successfulRows = 0
    this.consecutiveFailures++
    if (this.consecutiveFailures >= BatchSizeAdapter.FAILURE_THRESHOLD && this.levelIndex > 0) {
      this.levelIndex--
      this.currentSize = this.levels[this.levelIndex]
      this.consecutiveFailures = 0
    }
  }

  /**
   * Immediately step down one level — used for timeouts where the batch is clearly too large.
   * Returns true if the size actually changed (stepped down), false if already at minimum.
   */
  recordTimeout(): boolean {
    this.successfulRows = 0
    this.consecutiveFailures = 0
    if (this.levelIndex > 0) {
      this.levelIndex--
      this.currentSize = this.levels[this.levelIndex]
      return true
    }
    return false
  }

  /** True when the adapter is at the smallest possible batch size. */
  get isAtMinimum(): boolean {
    return this.levelIndex === 0
  }
}
