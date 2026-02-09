import { ImportStateMachine, ImportState } from './stateMachine'
import { parseCSVBatched, analyzeCSV, extractRowsByIndex, type ParseOptions } from './csvParser'
import { executeBatch, type BatchResult } from './batchExecutor'
import { RetryQueue } from './retryQueue'
import { WorkerPool, type Batch, type BatchProcessResult, calculateThroughput } from './workerPool'
import { useConfigStore } from '@/stores/config'
import { useRunStore } from '@/stores/run'
import { useFilesStore } from '@/stores/files'
import type { FileMapping } from '@/stores/config'
import { logger } from '@/utils/logger'
import { parseOdooError } from '@/utils/errors'

export interface ImportFile {
  id: string
  name: string
}

export class ImportEngine {
  private stateMachine = new ImportStateMachine()
  private retryQueue: RetryQueue
  private workerPool: WorkerPool | null = null
  private abortController: AbortController | null = null
  private skipFileController: AbortController | null = null

  // Throughput tracking
  private fileStartTime = 0
  private fileProcessedRows = 0

  constructor() {
    const config = useConfigStore()
    this.retryQueue = new RetryQueue(config.settings.retryLimit)
  }

  async start(files: ImportFile[]): Promise<void> {
    const config = useConfigStore()
    const run = useRunStore()

    this.abortController = new AbortController()

    this.stateMachine.transition(ImportState.VALIDATING)
    run.setState(ImportState.VALIDATING)

    // Build parse options from config settings
    const parseOptions: ParseOptions = {
      delimiter: config.settings.delimiter || undefined,
      encoding: config.settings.encoding,
      hasHeader: config.settings.skipHeader
    }

    // Analyze files (streaming line count)
    const rowCounts = new Map<string, number>()
    for (const file of files) {
      const analysis = await analyzeCSV(file.id)
      rowCounts.set(file.name, analysis.rowCount)
    }

    run.initRun(config.importSequence, rowCounts, config.settings.dryRun)

    if (this.abortController?.signal.aborted) return

    if (!this.stateMachine.tryTransition(ImportState.RUNNING_FILE)) {
      return
    }
    run.setState(ImportState.RUNNING_FILE)

    // Process files SEQUENTIALLY (never parallel)
    for (const filename of config.importSequence) {
      if (this.abortController.signal.aborted) break

      const file = files.find(f => f.name === filename)
      if (!file) continue

      // Create skip controller for this file
      this.skipFileController = new AbortController()

      try {
        logger.import.info(`Starting file: ${filename}`)
        await this.processFile(file, parseOptions)
        logger.import.info(`Completed file: ${filename}`)
      } catch (error) {
        // Check if file was skipped
        if (this.skipFileController?.signal.aborted) {
          logger.import.info(`Skipped file: ${filename}`)
          run.skipFile(filename)
          continue
        }

        const importError = parseOdooError(error, { filename })
        logger.import.error(`Failed to process file: ${filename}`, {
          error: importError.message,
          code: importError.code,
          severity: importError.severity
        })
        // Continue to next file or mark as failed
        run.addError({
          filename,
          rowNumber: 0,
          rawData: {},
          error: importError.message,
          timestamp: Date.now()
        })
      } finally {
        this.skipFileController = null
      }
    }

    // Always try to complete, even if there were errors
    if (!this.abortController.signal.aborted) {
      // Force state to COMPLETED - try from multiple possible states
      const completed = this.stateMachine.tryTransition(ImportState.COMPLETED)
      if (completed) {
        logger.import.info('Import completed successfully')
        run.setState(ImportState.COMPLETED)
      } else {
        // If transition failed, force the state in the store anyway
        logger.import.warn(`Could not transition to COMPLETED from ${this.stateMachine.state}, forcing state`)
        run.setState(ImportState.COMPLETED)
      }
    }
  }

  private async processFile(file: ImportFile, parseOptions: ParseOptions = {}): Promise<void> {
    const config = useConfigStore()
    const run = useRunStore()

    const mapping = config.getFileMapping(file.name)
    if (!mapping) {
      throw new Error(`No mapping for file: ${file.name}`)
    }

    run.startFile(file.name)
    this.retryQueue.clear()

    // Reset throughput tracking
    this.fileStartTime = Date.now()
    this.fileProcessedRows = 0

    // Create worker pool for this file
    const workers = Math.max(1, Math.min(4, config.settings.workers || 1))
    this.workerPool = new WorkerPool(workers)

    // Start worker pool with batch processor
    this.workerPool.start(
      (batch) => this.executeBatchWithMapping(batch, mapping, config.settings.dryRun),
      (result) => this.handleBatchResult(file.name, result)
    )

    // Stream CSV in batches and enqueue for workers
    await parseCSVBatched(
      file.id,
      config.settings.batchSize,
      async (batch) => {
        if (this.abortController?.signal.aborted) return
        if (this.skipFileController?.signal.aborted) return

        // Enqueue batch for worker pool (non-blocking)
        this.workerPool!.enqueueBatch(batch, file.name)
      },
      parseOptions
    )

    // Check if skipped before waiting for completion
    if (this.skipFileController?.signal.aborted) {
      this.workerPool?.abort()
      this.workerPool = null
      throw new Error('File skipped')
    }

    // Wait for all batches to complete
    if (!this.abortController?.signal.aborted && !this.skipFileController?.signal.aborted) {
      await this.workerPool.finishFile()
    }

    // Check again after batch completion
    if (this.skipFileController?.signal.aborted) {
      this.workerPool = null
      throw new Error('File skipped')
    }

    // Final retry pass for any remaining failures (ALWAYS serialized with workers=1)
    if (!this.abortController?.signal.aborted && !this.skipFileController?.signal.aborted) {
      await this.processRetries(file.name, mapping)
    }

    if (!this.abortController?.signal.aborted && !this.skipFileController?.signal.aborted) {
      run.completeFile(file.name)
    }

    this.workerPool = null
  }

  /**
   * Execute a batch using the file mapping.
   */
  private async executeBatchWithMapping(
    batch: Batch,
    mapping: FileMapping,
    dryRun?: boolean
  ): Promise<BatchResult[]> {
    return executeBatch(mapping.model, batch.rows, {
      fieldMappings: mapping.fieldMappings,
      searchKeys: mapping.searchKeys,
      strict: mapping.strict
    }, dryRun)
  }

  /**
   * Handle batch result from worker pool.
   * Centralized result collection - updates progress and queues retries.
   */
  private handleBatchResult(
    filename: string,
    result: BatchProcessResult
  ): void {
    if (this.abortController?.signal.aborted) return

    const run = useRunStore()
    const batch = result.results

    let successCount = 0
    let failedCount = 0

    // Collect results and queue failures for retry
    batch.forEach((rowResult) => {
      if (rowResult.ok) {
        successCount++
      } else {
        failedCount++
        run.addError({
          filename,
          rowNumber: rowResult.rowIndex,
          rawData: {},
          error: rowResult.error || 'Unknown error',
          timestamp: Date.now()
        })
      }
    })

    // Track processed rows for throughput
    this.fileProcessedRows += batch.length

    // Update progress
    const currentFile = run.currentFile
    if (currentFile) {
      run.updateFileProgress(filename, {
        processedRows: currentFile.processedRows + batch.length,
        successCount: currentFile.successCount + successCount,
        failedCount: currentFile.failedCount + failedCount
      })
    }
  }

  /**
   * Process retries - ALWAYS serialized with single worker.
   * This is critical for avoiding race conditions and DDOS-ing the server.
   */
  private async processRetries(filename: string, mapping: FileMapping): Promise<void> {
    if (this.abortController?.signal.aborted) return

    const config = useConfigStore()
    const run = useRunStore()

    const retryable = this.retryQueue.getRetryableRows()
    if (retryable.length === 0) return

    // Use tryTransition to avoid errors if state was reset due to abort
    if (!this.stateMachine.tryTransition(ImportState.RETRYING)) {
      return
    }
    run.setState(ImportState.RETRYING)

    await this.delay(config.settings.retryDelayMs)

    if (this.abortController?.signal.aborted) return

    // Process retries in single batches (serialized, workers=1)
    const rows = retryable.map(r => r.row)
    const results = await executeBatch(mapping.model, rows, mapping, config.settings.dryRun)

    if (this.abortController?.signal.aborted) return

    let successCount = 0

    results.forEach((result, idx) => {
      if (result.ok) {
        this.retryQueue.markSuccess(rows[idx].index)
        successCount++
      }
    })

    // Update success count from retries
    const currentFile = run.currentFile
    if (currentFile && successCount > 0) {
      run.updateFileProgress(filename, {
        successCount: currentFile.successCount + successCount,
        failedCount: currentFile.failedCount - successCount
      })
    }

    // Restore to RUNNING_FILE state after retries
    if (!this.abortController?.signal.aborted) {
      if (this.stateMachine.tryTransition(ImportState.RUNNING_FILE)) {
        run.setState(ImportState.RUNNING_FILE)
      }
    }
  }

  pause(): void {
    if (this.stateMachine.canPause) {
      this.stateMachine.transition(ImportState.PAUSED)
      useRunStore().setState(ImportState.PAUSED)
      // Actually pause the worker pool
      this.workerPool?.pause()
    }
  }

  resume(): void {
    if (this.stateMachine.state === ImportState.PAUSED) {
      this.stateMachine.transition(ImportState.RUNNING_FILE)
      useRunStore().setState(ImportState.RUNNING_FILE)
      // Actually resume the worker pool
      this.workerPool?.resume()
    }
  }

  abort(): void {
    this.abortController?.abort()
    this.skipFileController?.abort()
    this.workerPool?.abort()
    // Set to FAILED state instead of resetting, so results can be viewed
    this.stateMachine.reset()
    const run = useRunStore()
    run.setState(ImportState.FAILED)
  }

  skipCurrentFile(): void {
    if (this.skipFileController && !this.skipFileController.signal.aborted) {
      logger.import.info('Skipping current file...')
      this.skipFileController.abort()
      this.workerPool?.abort()
    }
  }

  /**
   * Retry all failed rows from the previous import run.
   * - Extracts failed rows from original files (no memory overhead during import)
   * - Processes files in sequence order
   * - Uses single batch per file (no parallel workers)
   * - No automatic retry on failure
   */
  async retryFailedRows(): Promise<void> {
    const config = useConfigStore()
    const run = useRunStore()
    const filesStore = useFilesStore()

    // Group errors by filename, collecting row numbers
    const errorsByFile = new Map<string, Set<number>>()
    for (const error of run.errors) {
      // Skip file-level errors (row 0) - only retry row-level failures
      if (error.rowNumber === 0) continue

      if (!errorsByFile.has(error.filename)) {
        errorsByFile.set(error.filename, new Set())
      }
      errorsByFile.get(error.filename)!.add(error.rowNumber)
    }

    if (errorsByFile.size === 0) {
      logger.import.warn('No failed rows to retry')
      return
    }

    // Filter to files that are still available and have mappings
    const filesToRetry: Array<{ filename: string; fileId: string; rowIndices: Set<number> }> = []

    for (const filename of config.importSequence) {
      const rowIndices = errorsByFile.get(filename)
      if (!rowIndices || rowIndices.size === 0) continue

      const mapping = config.getFileMapping(filename)
      if (!mapping) {
        logger.import.warn(`Skipping retry for ${filename}: no mapping found`)
        continue
      }

      const file = filesStore.files.find(f => f.name === filename)
      if (!file) {
        logger.import.warn(`Skipping retry for ${filename}: file no longer available`)
        continue
      }

      filesToRetry.push({ filename, fileId: file.id, rowIndices })
    }

    if (filesToRetry.length === 0) {
      logger.import.warn('No retryable files found (files removed or missing mappings)')
      return
    }

    this.abortController = new AbortController()

    // Initialize retry run
    this.stateMachine.transition(ImportState.VALIDATING)
    run.setState(ImportState.VALIDATING)

    const rowCounts = new Map<string, number>()
    for (const { filename, rowIndices } of filesToRetry) {
      rowCounts.set(filename, rowIndices.size)
    }

    run.initRun(filesToRetry.map(f => f.filename), rowCounts, config.settings.dryRun)

    if (this.abortController?.signal.aborted) return

    if (!this.stateMachine.tryTransition(ImportState.RUNNING_FILE)) {
      return
    }
    run.setState(ImportState.RUNNING_FILE)

    // Build parse options from config
    const parseOptions: ParseOptions = {
      delimiter: config.settings.delimiter || undefined,
      encoding: config.settings.encoding,
      hasHeader: config.settings.skipHeader
    }

    // Process files sequentially
    for (const { filename, fileId, rowIndices } of filesToRetry) {
      if (this.abortController.signal.aborted) break

      const mapping = config.getFileMapping(filename)
      if (!mapping) continue

      logger.import.info(`Retrying ${rowIndices.size} failed rows for: ${filename}`)
      run.startFile(filename)

      try {
        // Extract only the failed rows from the original file
        const rows = await extractRowsByIndex(fileId, rowIndices, parseOptions)

        if (rows.length === 0) {
          logger.import.warn(`No rows extracted for ${filename} - row indices may not match`)
          run.completeFile(filename)
          continue
        }

        if (this.abortController?.signal.aborted) break

        // Execute as single batch - no workers, no auto-retry
        const results = await executeBatch(
          mapping.model,
          rows,
          {
            fieldMappings: mapping.fieldMappings,
            searchKeys: mapping.searchKeys,
            strict: mapping.strict
          },
          config.settings.dryRun
        )

        if (this.abortController?.signal.aborted) break

        // Process results
        let successCount = 0
        let failedCount = 0
        const newErrors: typeof run.errors = []

        for (const result of results) {
          if (result.ok) {
            successCount++
          } else {
            failedCount++
            newErrors.push({
              filename,
              rowNumber: result.rowIndex,
              rawData: {},
              error: result.error || 'Unknown error',
              timestamp: Date.now()
            })
          }
        }

        // Update progress
        run.updateFileProgress(filename, {
          processedRows: rows.length,
          successCount,
          failedCount
        })

        // Replace old errors for this file with new ones
        const otherErrors = run.errors.filter(e => e.filename !== filename)
        run.errors.splice(0, run.errors.length, ...otherErrors, ...newErrors)

        run.completeFile(filename)
        logger.import.info(`Retry completed for ${filename}: ${successCount} succeeded, ${failedCount} failed`)

      } catch (error) {
        const importError = parseOdooError(error, { filename })
        logger.import.error(`Retry failed for file: ${filename}`, {
          error: importError.message
        })
        run.addError({
          filename,
          rowNumber: 0,
          rawData: {},
          error: importError.message,
          timestamp: Date.now()
        })
      }
    }

    // Complete
    if (!this.abortController.signal.aborted) {
      this.stateMachine.tryTransition(ImportState.COMPLETED)
      run.setState(ImportState.COMPLETED)
      logger.import.info('Retry completed')
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.abortController?.signal.aborted) {
        resolve()
        return
      }

      const timeout = setTimeout(resolve, ms)

      // Clean up if aborted during delay
      this.abortController?.signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
    })
  }

  get state(): ImportState {
    return this.stateMachine.state
  }

  /**
   * Get current throughput stats for display.
   */
  getThroughput(): { rowsPerSecond: number; display: string } {
    const config = useConfigStore()
    const elapsed = Date.now() - this.fileStartTime
    return calculateThroughput(
      this.fileProcessedRows,
      elapsed,
      config.settings.workers || 1
    )
  }

  /**
   * Get current worker count being used.
   */
  get activeWorkers(): number {
    return this.workerPool?.activeWorkerCount ?? 0
  }

  getFailedRowsCSV(headers: string[]): string {
    return this.retryQueue.exportFailedCSV(headers)
  }
}
