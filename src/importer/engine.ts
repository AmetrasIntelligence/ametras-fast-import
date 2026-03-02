import { ImportStateMachine, ImportState } from './stateMachine'
import { parseCSVBatched, analyzeCSV, extractRowsByIndex, type ParseOptions } from './csvParser'
import { executeBatch, NetworkBatchError, type BatchResult } from './batchExecutor'
import { ConnectionMonitor, type HealthCheckFn } from './connectionMonitor'
// standalone code flag (do not remove comment)
import {
  executeStandaloneBatch,
  BatchSizeAdapter,
  STANDALONE_MIN_BATCH_SIZE,
  STANDALONE_MAX_BATCH_SIZE
} from './standalone/executor'
import { RetryQueue } from './retryQueue'
import { WorkerPool, type Batch, type BatchProcessResult, calculateThroughput } from './workerPool'
import { useConfigStore } from '@/stores/config'
import { useRunStore } from '@/stores/run'
import { useFilesStore } from '@/stores/files'
import { useSessionStore } from '@/stores/session'  // standalone code flag (do not remove comment)
import type { FileMapping } from '@/stores/config'
import { logger } from '@/utils/logger'
import { parseOdooError } from '@/utils/errors'
import { runStateLock } from '@/utils/stateLock'
import {
  saveImportLog,
  createImportLog,
  updateImportLog,
  finalizeImportLog,
  type FileProgressData,
} from '@/api/odooClient'

/**
 * Convert a Set of row indices into sorted, compact [start, end] ranges.
 * E.g. {1,2,3,5,6,10} → [[1,3],[5,6],[10,10]]
 */
export function indicesToRanges(indices: Set<number>): [number, number][] {
  if (indices.size === 0) return []
  const sorted = [...indices].sort((a, b) => a - b)
  const ranges: [number, number][] = []
  let start = sorted[0]
  let end = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i]
    } else {
      ranges.push([start, end])
      start = sorted[i]
      end = sorted[i]
    }
  }
  ranges.push([start, end])
  return ranges
}

/**
 * Get effective batch size, applying standalone constraints if needed.
 * standalone code flag (do not remove comment)
 */
function getEffectiveBatchSize(configBatchSize: number, isStandalone: boolean): number {
  if (!isStandalone) {
    return configBatchSize
  }
  // Clamp to standalone limits
  const clamped = Math.max(
    STANDALONE_MIN_BATCH_SIZE,
    Math.min(STANDALONE_MAX_BATCH_SIZE, configBatchSize)
  )
  if (clamped !== configBatchSize) {
    logger.import.info(`[standalone] Batch size clamped from ${configBatchSize} to ${clamped} (limits: ${STANDALONE_MIN_BATCH_SIZE}-${STANDALONE_MAX_BATCH_SIZE})`)
  }
  return clamped
}

export interface ImportFile {
  id: string
  name: string
}

export interface ResumeState {
  logId: number
  fileProgress: Record<string, FileProgressData>
  errorLog: Array<{ filename: string; rowNumber: number; error: string }>
}

/**
 * Compute row indices NOT covered by the given processedRanges.
 * Returns a Set of indices from 1..totalRows that are not in any range.
 */
function indicesNotInRanges(totalRows: number, ranges: [number, number][]): Set<number> {
  const covered = new Set<number>()
  for (const [start, end] of ranges) {
    for (let i = start; i <= end; i++) {
      covered.add(i)
    }
  }
  const result = new Set<number>()
  for (let i = 1; i <= totalRows; i++) {
    if (!covered.has(i)) {
      result.add(i)
    }
  }
  return result
}

/**
 * Extract failed row indices from error log for a given file.
 */
function failedIndicesFromErrorLog(
  errorLog: Array<{ filename: string; rowNumber: number }>,
  filename: string
): Set<number> {
  const indices = new Set<number>()
  for (const entry of errorLog) {
    if (entry.filename === filename && entry.rowNumber > 0) {
      indices.add(entry.rowNumber)
    }
  }
  return indices
}

export class ImportEngine {
  private stateMachine = new ImportStateMachine()
  private retryQueue: RetryQueue
  private workerPool: WorkerPool | null = null
  private abortController: AbortController | null = null
  private skipFileController: AbortController | null = null
  private batchSizeAdapter: BatchSizeAdapter | null = null
  private connectionMonitor: ConnectionMonitor | null = null

  // Throughput tracking
  private fileStartTime = 0
  private fileProcessedRows = 0

  // Log lifecycle tracking
  private logId: number | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private processedIndices = new Map<string, Set<number>>()

  constructor() {
    const config = useConfigStore()
    this.retryQueue = new RetryQueue(config.settings.retryLimit)
  }

  async start(files: ImportFile[], resumeState?: ResumeState): Promise<void> {
    const config = useConfigStore()
    const run = useRunStore()

    this.abortController = new AbortController()

    // Initialize connection monitor with appropriate health check for the current mode
    this.connectionMonitor = new ConnectionMonitor(this.createHealthCheckFn())

    this.stateMachine.transition(ImportState.VALIDATING)
    run.setState(ImportState.VALIDATING)

    // Build parse options from config settings
    const parseOptions: ParseOptions = {
      delimiter: config.settings.delimiter || undefined,
      encoding: config.settings.encoding,
      hasHeader: config.settings.skipHeader
    }

    // Determine which rows to process per file
    // For resume: compute pending + failed rows only
    const rowCounts = new Map<string, number>()
    const resumeRowFilters = new Map<string, Set<number>>()

    if (resumeState) {
      // Resume mode: calculate rows to process from file_progress + error_log
      for (const file of files) {
        const fp = resumeState.fileProgress[file.name]
        if (!fp) {
          // File not in progress — process all rows
          const analysis = await analyzeCSV(file.id)
          rowCounts.set(file.name, analysis.rowCount)
          continue
        }

        // Pending = not in processedRanges
        const pendingIndices = indicesNotInRanges(fp.totalRows, fp.processedRanges)
        // Failed = in error_log for this file
        const failedIndices = failedIndicesFromErrorLog(resumeState.errorLog, file.name)

        // Union of pending + failed
        const toProcess = new Set<number>([...pendingIndices, ...failedIndices])

        if (toProcess.size === 0) {
          // All rows already succeeded — skip this file
          logger.import.info(`[resume] Skipping ${file.name}: all rows already succeeded`)
          continue
        }

        rowCounts.set(file.name, toProcess.size)
        resumeRowFilters.set(file.name, toProcess)
      }
    } else {
      // Normal mode: analyze files (streaming line count)
      for (const file of files) {
        const analysis = await analyzeCSV(file.id)
        rowCounts.set(file.name, analysis.rowCount)
      }
    }

    run.initRun(config.importSequence, rowCounts, config.settings.dryRun)

    if (this.abortController?.signal.aborted) return

    // Log lifecycle: create or reuse log record
    this.processedIndices.clear()
    if (resumeState) {
      // Reuse existing log record
      this.logId = resumeState.logId
      run.logId = this.logId
      // Set log state back to 'running'
      try {
        await updateImportLog({
          log_id: this.logId,
          success_rows: 0, // will be updated during import
          failed_rows: 0,
          file_progress: resumeState.fileProgress,
        })
      } catch (err) {
        logger.import.warn('Failed to update log for resume', { error: (err as Error).message })
      }
    } else {
      // Create new log record
      const totalRows = [...rowCounts.values()].reduce((a, b) => a + b, 0)
      try {
        this.logId = await createImportLog({
          profile_name: config.activeProfileId ? `Profile #${config.activeProfileId}` : '',
          profile_id: config.activeProfileId ?? undefined,
          is_dry_run: config.settings.dryRun ?? false,
          started_at: new Date().toISOString(),
          filenames: config.importSequence,
          total_rows: totalRows,
        })
        if (this.logId) {
          run.logId = this.logId
        }
      } catch (err) {
        logger.import.warn('Failed to create import log record', { error: (err as Error).message })
      }
    }

    // Start heartbeat timer (every 30s)
    this.startHeartbeat()

    if (!this.stateMachine.tryTransition(ImportState.RUNNING_FILE)) {
      return
    }
    run.setState(ImportState.RUNNING_FILE)

    // Process files SEQUENTIALLY (never parallel)
    for (const filename of config.importSequence) {
      if (this.abortController.signal.aborted) break

      // Skip files with 0 rows to process (already completed in resume)
      if (!rowCounts.has(filename) || rowCounts.get(filename) === 0) continue

      const file = files.find(f => f.name === filename)
      if (!file) {
        logger.import.warn(`File "${filename}" is in import sequence but not in files list — skipping`)
        continue
      }

      // Create skip controller for this file
      this.skipFileController = new AbortController()

      try {
        const rowFilter = resumeRowFilters.get(filename)
        if (rowFilter) {
          // Resume mode: extract only specific rows
          logger.import.info(`[resume] Starting file: ${filename} (${rowFilter.size} rows to process)`)
          await this.processFileWithFilter(file, rowFilter, parseOptions)
        } else {
          logger.import.info(`Starting file: ${filename}`)
          await this.processFile(file, parseOptions)
        }
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
      if (this.stateMachine.tryTransition(ImportState.COMPLETED)) {
        logger.import.info('Import completed successfully')
        run.setState(ImportState.COMPLETED)
      } else {
        // State machine is in an unexpected state - don't silently force COMPLETED
        // as that desynchronizes the state machine from the store.
        logger.import.error(
          `Cannot transition to COMPLETED from ${this.stateMachine.state}. Marking as FAILED.`
        )
        this.stateMachine.reset()
        run.setState(ImportState.FAILED)
      }
      this.finalizeLog()
    }
  }

  /**
   * Process a file with only specific row indices (for resume).
   * Extracts the target rows, then processes them like a normal batch import.
   */
  private async processFileWithFilter(
    file: ImportFile,
    rowFilter: Set<number>,
    parseOptions: ParseOptions = {}
  ): Promise<void> {
    const config = useConfigStore()
    const run = useRunStore()

    const mapping = config.getFileMapping(file.name)
    if (!mapping) {
      throw new Error(`No mapping for file: ${file.name}`)
    }

    const settings = { ...config.settings }

    run.startFile(file.name)
    this.retryQueue.clear()
    this.fileStartTime = Date.now()
    this.fileProcessedRows = 0

    // standalone code flag (do not remove comment)
    const session = useSessionStore()
    const importMode = session.importMode ?? 'addon'
    const effectiveBatchSize = getEffectiveBatchSize(
      settings.batchSize,
      importMode === 'standalone'
    )

    this.batchSizeAdapter = importMode === 'standalone'
      ? new BatchSizeAdapter(effectiveBatchSize)
      : null

    // Extract only the target rows from the file
    const rows = await extractRowsByIndex(file.id, rowFilter, parseOptions)

    if (rows.length === 0) {
      logger.import.warn(`[resume] No rows extracted for ${file.name}`)
      run.completeFile(file.name)
      this.batchSizeAdapter = null
      return
    }

    if (this.abortController?.signal.aborted) return

    // Create worker pool
    const maxWorkers = importMode === 'standalone' ? 1 : 4
    const workers = Math.max(1, Math.min(maxWorkers, settings.workers || 1))
    this.workerPool = new WorkerPool(workers)

    this.workerPool.start(
      (batch) => this.executeBatchWithMapping(batch, mapping, settings.dryRun, importMode),
      (result) => this.handleBatchResult(file.name, result)
    )

    // Enqueue rows in batches
    for (let i = 0; i < rows.length; i += effectiveBatchSize) {
      if (this.abortController?.signal.aborted) break
      if (this.skipFileController?.signal.aborted) break

      await this.workerPool.waitWhilePaused()
      if (this.abortController?.signal.aborted) break
      if (this.skipFileController?.signal.aborted) break

      const batchRows = rows.slice(i, i + effectiveBatchSize)
      try {
        this.workerPool.enqueueBatch(batchRows, file.name)
      } catch (err) {
        if (this.abortController?.signal.aborted || this.skipFileController?.signal.aborted) break
        throw err
      }
    }

    if (this.skipFileController?.signal.aborted) {
      this.workerPool?.abort()
      this.workerPool = null
      throw new Error('File skipped')
    }

    if (!this.abortController?.signal.aborted && !this.skipFileController?.signal.aborted) {
      await this.workerPool.finishFile()
    }

    if (this.skipFileController?.signal.aborted) {
      this.workerPool = null
      throw new Error('File skipped')
    }

    // Retry pass
    if (!this.abortController?.signal.aborted && !this.skipFileController?.signal.aborted) {
      await this.processRetries(file.name, mapping, settings, importMode)
    }

    if (!this.abortController?.signal.aborted && !this.skipFileController?.signal.aborted) {
      run.completeFile(file.name)
    }

    this.workerPool = null
    this.batchSizeAdapter = null
  }

  private async processFile(file: ImportFile, parseOptions: ParseOptions = {}): Promise<void> {
    const config = useConfigStore()
    const run = useRunStore()

    const mapping = config.getFileMapping(file.name)
    if (!mapping) {
      throw new Error(`No mapping for file: ${file.name}`)
    }

    // Snapshot config settings for this file so they remain consistent
    // even if the store is mutated during processing (e.g. navigation).
    const settings = { ...config.settings }

    run.startFile(file.name)
    this.retryQueue.clear()

    // Reset throughput tracking
    this.fileStartTime = Date.now()
    this.fileProcessedRows = 0

    // standalone code flag (do not remove comment)
    // Get effective batch size (applies standalone constraints if needed)
    const session = useSessionStore()
    const importMode = session.importMode ?? 'addon'
    const effectiveBatchSize = getEffectiveBatchSize(
      settings.batchSize,
      importMode === 'standalone'
    )

    // Create adaptive batch size adapter for standalone mode
    this.batchSizeAdapter = importMode === 'standalone'
      ? new BatchSizeAdapter(effectiveBatchSize)
      : null

    // Create worker pool for this file
    // In standalone mode, limit to 1 worker for stability
    const maxWorkers = importMode === 'standalone' ? 1 : 4
    const workers = Math.max(1, Math.min(maxWorkers, settings.workers || 1))
    this.workerPool = new WorkerPool(workers)

    // Start worker pool with batch processor
    this.workerPool.start(
      (batch) => this.executeBatchWithMapping(batch, mapping, settings.dryRun, importMode),
      (result) => this.handleBatchResult(file.name, result)
    )

    // Stream CSV in batches and enqueue for workers
    await parseCSVBatched(
      file.id,
      effectiveBatchSize,
      async (batch) => {
        if (this.abortController?.signal.aborted) return
        if (this.skipFileController?.signal.aborted) return

        // Honor pause state: stop streaming CSV until resumed.
        // Without this, streaming would fill the queue unboundedly while paused.
        await this.workerPool!.waitWhilePaused()
        if (this.abortController?.signal.aborted) return
        if (this.skipFileController?.signal.aborted) return

        // Enqueue batch for worker pool (non-blocking)
        // The queue may have been closed by a concurrent skip/abort between
        // our signal check above and the actual push. Catch and ignore in
        // that case — the skip/abort will be handled after streaming ends.
        try {
          this.workerPool!.enqueueBatch(batch, file.name)
        } catch (err) {
          if (this.abortController?.signal.aborted || this.skipFileController?.signal.aborted) {
            return
          }
          throw err
        }
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
      await this.processRetries(file.name, mapping, settings, importMode)
    }

    if (!this.abortController?.signal.aborted && !this.skipFileController?.signal.aborted) {
      run.completeFile(file.name)
    }

    this.workerPool = null
    this.batchSizeAdapter = null
  }

  /**
   * Execute a batch using the file mapping.
   * Uses standalone executor when ametras_fast_import addon is not available.
   * Accepts snapshotted values to avoid re-reading stores mid-file.
   *
   * On network errors: pauses the engine, waits for reconnection via
   * ConnectionMonitor, then retries the same batch automatically.
   */
  private async executeBatchWithMapping(
    batch: Batch,
    mapping: FileMapping,
    dryRun: boolean | undefined,
    importMode: string
  ): Promise<BatchResult[]> {
    while (true) {
      try {
        let results: BatchResult[]

        // standalone code flag (do not remove comment)
        if (importMode === 'standalone') {
          // Use standalone executor (direct Odoo API)
          results = await executeStandaloneBatch(mapping.model, batch.rows, {
            fieldMappings: mapping.fieldMappings
            // Note: searchKeys, strict not supported in standalone mode
          }, dryRun, this.abortController?.signal, this.batchSizeAdapter ?? undefined)
        } else {
          // Use addon executor (default)
          results = await executeBatch(mapping.model, batch.rows, {
            fieldMappings: mapping.fieldMappings,
            searchKeys: mapping.searchKeys,
            strict: mapping.strict
          }, dryRun)
        }

        // Successful batch — signal online
        this.connectionMonitor?.reportOnline()
        return results
      } catch (error) {
        if (!(error instanceof NetworkBatchError)) {
          throw error
        }

        // Network error — pause and wait for reconnection
        logger.import.warn(`[engine] Network error during batch: ${error.message}. Pausing for reconnection...`)

        const run = useRunStore()
        this.connectionMonitor?.reportOffline()
        run.connectionStatus = 'offline'

        // Pause the engine (state machine + store)
        const wasRunning = this.stateMachine.canPause
        if (wasRunning) {
          this.stateMachine.transition(ImportState.PAUSED)
          run.setState(ImportState.PAUSED)
          this.workerPool?.pause()
        }

        // Block until server is reachable again (or abort)
        try {
          await this.connectionMonitor!.waitForConnection(this.abortController?.signal)
        } catch {
          // Aborted during wait — break out, let normal abort flow handle it
          return batch.rows.map(row => ({
            ok: false,
            error: 'Import aborted during reconnection wait',
            rowIndex: row.index
          }))
        }

        // Reconnected — restore state and retry the same batch
        run.connectionStatus = 'online'
        if (wasRunning) {
          if (this.stateMachine.state === ImportState.PAUSED) {
            this.stateMachine.transition(ImportState.RUNNING_FILE)
            run.setState(ImportState.RUNNING_FILE)
            this.workerPool?.resume()
          }
        }
        logger.import.info('[engine] Reconnected. Retrying batch...')
        // Loop continues to retry
      }
    }
  }

  /**
   * Handle batch result from worker pool.
   * Centralized result collection - updates progress and queues retries.
   * Uses state lock to prevent concurrent mutations from multiple workers.
   * standalone code flag (do not remove comment)
   */
  private handleBatchResult(
    filename: string,
    result: BatchProcessResult
  ): void {
    if (this.abortController?.signal.aborted) return

    // Use lock to serialize state updates from concurrent workers
    runStateLock.withLock(() => {
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

      // standalone code flag - add failed rows to retry queue for later retry pass
      if (failedCount > 0 && result.rows) {
        this.retryQueue.addFailedRows(result.rows, batch)
      }

      // Track processed row indices for log lifecycle
      if (!this.processedIndices.has(filename)) {
        this.processedIndices.set(filename, new Set())
      }
      const fileIndices = this.processedIndices.get(filename)!
      for (const rowResult of batch) {
        fileIndices.add(rowResult.rowIndex)
      }

      // Track processed rows for throughput
      this.fileProcessedRows += batch.length

      // Update progress atomically
      const currentFile = run.currentFile
      if (currentFile) {
        run.updateFileProgress(filename, {
          processedRows: currentFile.processedRows + batch.length,
          successCount: currentFile.successCount + successCount,
          failedCount: currentFile.failedCount + failedCount
        })
      }
    })
  }

  /**
   * Process retries - ALWAYS serialized with single worker.
   * This is critical for avoiding race conditions and DDOS-ing the server.
   */
  private async processRetries(
    filename: string,
    mapping: FileMapping,
    settings: { dryRun?: boolean; retryDelayMs: number },
    importMode: string
  ): Promise<void> {
    if (this.abortController?.signal.aborted) return

    const run = useRunStore()

    const retryable = this.retryQueue.getRetryableRows()
    if (retryable.length === 0) return

    // Use tryTransition to avoid errors if state was reset due to abort
    if (!this.stateMachine.tryTransition(ImportState.RETRYING)) {
      return
    }
    run.setState(ImportState.RETRYING)

    await this.delay(settings.retryDelayMs)

    if (this.abortController?.signal.aborted) return

    // Process retries in single batches (serialized, workers=1)
    const rows = retryable.map(r => r.row)
    // standalone code flag (do not remove comment)
    let results: BatchResult[]
    if (importMode === 'standalone') {
      results = await executeStandaloneBatch(
        mapping.model,
        rows,
        { fieldMappings: mapping.fieldMappings },
        settings.dryRun,
        this.abortController?.signal,
        this.batchSizeAdapter ?? undefined
      )
    } else {
      results = await executeBatch(
        mapping.model,
        rows,
        mapping,
        settings.dryRun
      )
    }

    if (this.abortController?.signal.aborted) return

    let successCount = 0
    const succeededRowIndices = new Set<number>()

    results.forEach((result, idx) => {
      if (result.ok) {
        this.retryQueue.markSuccess(rows[idx].index)
        succeededRowIndices.add(rows[idx].index)
        successCount++
      }
    })

    // Update success count from retries and remove resolved errors
    const currentFile = run.currentFile
    if (currentFile && successCount > 0) {
      run.updateFileProgress(filename, {
        successCount: currentFile.successCount + successCount,
        failedCount: currentFile.failedCount - successCount
      })
      // Remove errors for rows that succeeded on retry so the error table
      // stays consistent with the progress counts
      run.errors.splice(
        0, run.errors.length,
        ...run.errors.filter(e => e.filename !== filename || !succeededRowIndices.has(e.rowNumber))
      )
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
    this.connectionMonitor?.destroy()
    this.stopHeartbeat()
    // Set to FAILED state instead of resetting, so results can be viewed
    this.stateMachine.reset()
    const run = useRunStore()
    run.setState(ImportState.FAILED)
    this.finalizeLog()
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
        // standalone code flag (do not remove comment)
        const session = useSessionStore()
        // Fresh adapter per file — different operation, unknown data quality
        const retryAdapter = session.importMode === 'standalone'
          ? new BatchSizeAdapter(getEffectiveBatchSize(config.settings.batchSize, true))
          : undefined
        let results: BatchResult[]
        if (session.importMode === 'standalone') {
          results = await executeStandaloneBatch(
            mapping.model,
            rows,
            { fieldMappings: mapping.fieldMappings },
            config.settings.dryRun,
            this.abortController?.signal,
            retryAdapter
          )
        } else {
          results = await executeBatch(
            mapping.model,
            rows,
            {
              fieldMappings: mapping.fieldMappings,
              searchKeys: mapping.searchKeys,
              strict: mapping.strict
            },
            config.settings.dryRun
          )
        }

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
      if (this.stateMachine.tryTransition(ImportState.COMPLETED)) {
        run.setState(ImportState.COMPLETED)
        logger.import.info('Retry completed')
      } else {
        logger.import.error(
          `Cannot transition to COMPLETED from ${this.stateMachine.state} after retry. Marking as FAILED.`
        )
        this.stateMachine.reset()
        run.setState(ImportState.FAILED)
      }
      this.finalizeLog()
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

  /**
   * Create a health check function appropriate for the current import mode.
   * - Embedded mode: uses the default same-origin fetch to /ametras_fast_import/info
   * - Standalone mode: uses window.api.odoo.call with /web/session/get_session_info
   */
  private createHealthCheckFn(): HealthCheckFn | undefined {
    const session = useSessionStore()
    if (session.isEmbedded) {
      // Embedded mode: use the default health check (same-origin fetch)
      return undefined
    }
    // Standalone/Electron mode: use the IPC bridge with a universal endpoint
    const baseUrl = session.baseUrl
    const db = session.currentServer?.db
    return async () => {
      try {
        const result = await window.api.odoo.call({
          baseUrl: baseUrl || '',
          db,
          endpoint: '/web/session/get_session_info',
          params: {},
        })
        return result.ok === true
      } catch {
        return false
      }
    }
  }

  /**
   * Build file_progress data from processedIndices for the log record.
   */
  private buildFileProgress(): Record<string, FileProgressData> {
    const run = useRunStore()
    const result: Record<string, FileProgressData> = {}

    for (const [filename, indices] of this.processedIndices.entries()) {
      const fileProgress = run.progress.files[filename]
      result[filename] = {
        totalRows: fileProgress?.totalRows ?? 0,
        successCount: fileProgress?.successCount ?? 0,
        failedCount: fileProgress?.failedCount ?? 0,
        processedRanges: indicesToRanges(indices),
      }
    }
    return result
  }

  /**
   * Start periodic heartbeat updates to the server (every 30s).
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat()
    }, 30_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private sendHeartbeat(): void {
    if (!this.logId) return
    const run = useRunStore()
    const files = Object.values(run.progress.files)
    const successRows = files.reduce((sum, f) => sum + f.successCount, 0)
    const failedRows = files.reduce((sum, f) => sum + f.failedCount, 0)

    updateImportLog({
      log_id: this.logId,
      success_rows: successRows,
      failed_rows: failedRows,
      file_progress: this.buildFileProgress(),
    }).catch(err => logger.import.warn('Failed to send heartbeat', { error: (err as Error).message }))
  }

  /**
   * Finalize the log record on the server (fire-and-forget).
   * If no logId exists (creation failed), falls back to legacy saveImportLog().
   */
  private finalizeLog(): void {
    this.stopHeartbeat()
    const run = useRunStore()
    const config = useConfigStore()

    const files = Object.values(run.progress.files)
    const totalRows = files.reduce((sum, f) => sum + f.totalRows, 0)
    const successRows = files.reduce((sum, f) => sum + f.successCount, 0)
    const failedRows = files.reduce((sum, f) => sum + f.failedCount, 0)
    const filenames = Object.keys(run.progress.files)

    const startedAt = run.runStartTime
      ? new Date(run.runStartTime).toISOString()
      : new Date().toISOString()
    const finishedAt = new Date().toISOString()

    const errorLog = run.errors.map(e => ({
      filename: e.filename,
      rowNumber: e.rowNumber,
      error: e.error,
    }))

    const state = failedRows > 0 ? 'failed' as const : 'completed' as const

    if (this.logId) {
      // Use new finalize endpoint
      finalizeImportLog({
        log_id: this.logId,
        state,
        finished_at: finishedAt,
        total_rows: totalRows,
        success_rows: successRows,
        failed_rows: failedRows,
        error_log: errorLog,
        file_progress: this.buildFileProgress(),
      }).catch(err => logger.import.error('Failed to finalize log', { error: (err as Error).message }))
    } else {
      // Legacy fallback (log creation failed or standalone mode)
      saveImportLog({
        profile_name: config.activeProfileId ? `Profile #${config.activeProfileId}` : '',
        profile_id: config.activeProfileId ?? undefined,
        is_dry_run: run.isDryRun,
        state,
        started_at: startedAt,
        finished_at: finishedAt,
        filenames,
        total_rows: totalRows,
        success_rows: successRows,
        failed_rows: failedRows,
        error_log: errorLog,
      }).catch(err => logger.import.error('Failed to save log', { error: (err as Error).message }))
    }
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
