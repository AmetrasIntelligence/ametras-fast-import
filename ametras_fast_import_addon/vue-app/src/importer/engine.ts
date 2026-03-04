import { ImportStateMachine, ImportState } from './stateMachine'
import { parseCSVBatched, analyzeCSV, extractRowsByIndex, type ParseOptions } from './csvParser'
import { NetworkBatchError, AuthBatchError, TimeoutBatchError, detectIdColumn, type BatchResult } from './batchExecutor'
import { ConnectionMonitor, type HealthCheckFn } from './connectionMonitor'
import { RetryQueue } from './retryQueue'
import { WorkerPool, type Batch, type BatchProcessResult, calculateThroughput } from './workerPool'
import { useConfigStore } from '@/stores/config'
import { useRunStore } from '@/stores/run'
import { useFilesStore } from '@/stores/files'
import { useSessionStore } from '@/stores/session'
import { usePlatformStore } from '@/stores/platform'
import type { FileMapping } from '@/stores/config'
import { logger } from '@/utils/logger'
import { parseOdooError } from '@/utils/errors'
import { runStateLock } from '@/utils/stateLock'
import {
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
  // Walk sorted ranges and collect gaps — O(R log R + gaps) instead of O(N)
  const sorted = ranges.length > 0
    ? ranges.slice().sort((a, b) => a[0] - b[0])
    : []
  const result = new Set<number>()
  let cursor = 1
  for (const [start, end] of sorted) {
    for (let i = cursor; i < start; i++) {
      result.add(i)
    }
    if (end + 1 > cursor) {
      cursor = end + 1
    }
  }
  for (let i = cursor; i <= totalRows; i++) {
    result.add(i)
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
  private batchSizeAdapter: unknown = null
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

    // Log lifecycle: create or reuse log record (only when server logs are available)
    const platform = usePlatformStore()
    this.processedIndices.clear()
    if (platform.capabilities.serverLogs) {
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
    }

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
          run.isSkipping = false
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
        run.completeFile(filename)
      } finally {
        this.skipFileController = null
        // Clear all per-file transitional UI flags so stale state
        // never leaks into the next file or the completed screen.
        run.isInitiating = false
        run.isPausing = false
        run.isSkipping = false
      }
    }

    // Clean up adapter after all files are done
    this.batchSizeAdapter = null

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

    // Clean up connection monitor so its health-check polling does not
    // continue after the import finishes (leak would interfere with
    // subsequent operations like profile loading).
    this.connectionMonitor?.destroy()
    this.connectionMonitor = null
  }

  /**
   * Process a file with only specific row indices (for resume).
   * Extracts the target rows, then processes them via the shared core.
   */
  private async processFileWithFilter(
    file: ImportFile,
    rowFilter: Set<number>,
    parseOptions: ParseOptions = {}
  ): Promise<void> {
    const rows = await extractRowsByIndex(file.id, rowFilter, parseOptions)
    return this.processFileCore(file, { rows }, parseOptions)
  }

  /**
   * Process a file by streaming all rows from CSV.
   */
  private async processFile(file: ImportFile, parseOptions: ParseOptions = {}): Promise<void> {
    return this.processFileCore(file, 'stream', parseOptions)
  }

  /**
   * Shared file processing core.
   * rowSource = 'stream': parse CSV via streaming (normal import)
   * rowSource = { rows }: use pre-fetched rows (resume import)
   */
  private async processFileCore(
    file: ImportFile,
    rowSource: 'stream' | { rows: import('./csvParser').ParsedRow[] },
    parseOptions: ParseOptions = {}
  ): Promise<void> {
    const config = useConfigStore()
    const run = useRunStore()
    const platform = usePlatformStore()

    const mapping = config.getFileMapping(file.name)
    if (!mapping) {
      throw new Error(`No mapping for file: ${file.name}`)
    }

    // Snapshot config settings for this file so they remain consistent
    // even if the store is mutated during processing (e.g. navigation).
    const settings = { ...config.settings }

    run.startFile(file.name)
    run.isInitiating = true
    this.retryQueue.clear()
    this.fileStartTime = Date.now()
    this.fileProcessedRows = 0

    const effectiveBatchSize = Math.max(
      platform.batchSizeRange.min,
      Math.min(platform.batchSizeRange.max, settings.batchSize)
    )

    // Reuse existing adapter across files so the learned batch size carries
    // over.  A fresh adapter starts at size 1 (warm-up) and takes ~100 rows
    // to ramp up, causing long stalls between files.
    if (!this.batchSizeAdapter) {
      this.batchSizeAdapter = platform.createBatchAdapter?.(effectiveBatchSize) ?? null
    }

    // For pre-fetched rows, check if empty
    if (rowSource !== 'stream') {
      if (rowSource.rows.length === 0) {
        logger.import.warn(`[resume] No rows extracted for ${file.name}`)
        run.completeFile(file.name)
        this.batchSizeAdapter = null
        return
      }
      if (this.abortController?.signal.aborted) return
    }

    // Create worker pool
    const workers = Math.max(1, Math.min(platform.maxWorkers, settings.workers || 1))
    this.workerPool = new WorkerPool(workers)

    this.workerPool.start(
      (batch) => this.executeBatchWithMapping(batch, mapping, settings.dryRun),
      (result) => this.handleBatchResult(file.name, result)
    )

    // Feed batches to worker pool from the appropriate source
    if (rowSource === 'stream') {
      await parseCSVBatched(
        file.id,
        effectiveBatchSize,
        async (batch) => {
          if (this.abortController?.signal.aborted) return
          if (this.skipFileController?.signal.aborted) return

          // Honor pause state: stop streaming CSV until resumed.
          await this.workerPool!.waitWhilePaused()
          if (this.abortController?.signal.aborted) return
          if (this.skipFileController?.signal.aborted) return

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
    } else {
      for (let i = 0; i < rowSource.rows.length; i += effectiveBatchSize) {
        if (this.abortController?.signal.aborted) break
        if (this.skipFileController?.signal.aborted) break

        await this.workerPool.waitWhilePaused()
        if (this.abortController?.signal.aborted) break
        if (this.skipFileController?.signal.aborted) break

        const batchRows = rowSource.rows.slice(i, i + effectiveBatchSize)
        try {
          this.workerPool.enqueueBatch(batchRows, file.name)
        } catch (err) {
          if (this.abortController?.signal.aborted || this.skipFileController?.signal.aborted) break
          throw err
        }
      }
    }

    // Completion flow (shared for both sources)
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

    // Final retry pass (ALWAYS serialized with workers=1)
    if (!this.abortController?.signal.aborted && !this.skipFileController?.signal.aborted) {
      await this.processRetries(file.name, mapping, settings)
    }

    // processRetries may exit early (skip/abort during reconnection wait or
    // delay) leaving state at RETRYING.  Normalize back to RUNNING_FILE so
    // the next file's processRetries transition (RUNNING_FILE → RETRYING)
    // doesn't fail due to an invalid RETRYING → RETRYING self-transition.
    if (!this.abortController?.signal.aborted && this.stateMachine.state !== ImportState.RUNNING_FILE) {
      if (this.stateMachine.tryTransition(ImportState.RUNNING_FILE)) {
        run.setState(ImportState.RUNNING_FILE)
      }
    }

    // If file was skipped during retries (e.g. while waiting for reconnection),
    // processRetries returns normally without throwing, so the catch block in
    // start() won't trigger skipFile(). Throw here so it gets handled properly.
    if (this.skipFileController?.signal.aborted) {
      throw new Error('File skipped')
    }

    run.isInitiating = false
    if (!this.abortController?.signal.aborted && !this.skipFileController?.signal.aborted) {
      run.completeFile(file.name)
    }

    this.workerPool = null
    // Note: batchSizeAdapter is intentionally NOT reset here — it carries
    // the learned batch size to the next file for faster start-up.
  }

  /**
   * Execute a batch using the file mapping.
   * Uses the platform-injected executor.
   *
   * On network errors: pauses the engine, waits for reconnection via
   * ConnectionMonitor, then retries the same batch automatically.
   */
  private async executeBatchWithMapping(
    batch: Batch,
    mapping: FileMapping,
    dryRun: boolean | undefined,
  ): Promise<BatchResult[]> {
    const platform = usePlatformStore()
    const MAX_AUTH_RETRIES = 2
    let authRetryCount = 0
    const MAX_NETWORK_RETRIES = 3
    let networkRetryCount = 0

    while (true) {
      // Check if file was skipped before retrying
      if (this.skipFileController?.signal.aborted) {
        return batch.rows.map(row => ({
          ok: false, error: 'File skipped', rowIndex: row.index
        }))
      }
      try {
        const results = await platform.executeBatch(
          mapping.model,
          batch.rows,
          {
            fieldMappings: mapping.fieldMappings,
            searchKeys: mapping.searchKeys,
            strict: mapping.strict,
          },
          {
            dryRun,
            signal: this.abortController?.signal,
            batchAdapter: this.batchSizeAdapter,
          }
        )

        // Successful batch — signal online
        this.connectionMonitor?.reportOnline()
        return results
      } catch (error) {
        // Auth error — pause and retry (re-auth may succeed after cooldown)
        if (error instanceof AuthBatchError) {
          authRetryCount++
          if (authRetryCount > MAX_AUTH_RETRIES) {
            logger.import.error('[engine] Authentication failed after retries — stopping import.')
            this.abort()
            return batch.rows.map(row => ({
              ok: false,
              error: 'Authentication failed: ' + error.message,
              rowIndex: row.index,
            }))
          }
          logger.import.warn(
            `[engine] Auth error (attempt ${authRetryCount}/${MAX_AUTH_RETRIES}): ${error.message}. Pausing for reconnection...`
          )
          // Fall through to shared reconnection logic below
        }

        // Timeout error — check for idempotency keys before retrying
        if (error instanceof TimeoutBatchError) {
          const hasIdempotencyKey = !!(
            mapping.searchKeys?.length ||
            detectIdColumn(mapping.fieldMappings)
          )
          if (!hasIdempotencyKey) {
            logger.import.warn(
              '[engine] Timeout without idempotency key — failing batch to avoid duplicates'
            )
            return batch.rows.map(row => ({
              ok: false,
              error: 'Request timed out. Add external IDs or search keys to enable safe retry.',
              rowIndex: row.index,
            }))
          }
          // Has idempotency key — safe to retry (upsert semantics)
          logger.import.warn('[engine] Timeout with idempotency key — retrying (upsert-safe)')
          // Fall through to NetworkBatchError reconnection logic
        }

        if (
          !(error instanceof NetworkBatchError) &&
          !(error instanceof TimeoutBatchError) &&
          !(error instanceof AuthBatchError)
        ) {
          throw error
        }

        // Network/auth/timeout error — pause and wait for reconnection
        networkRetryCount++
        if (networkRetryCount > MAX_NETWORK_RETRIES) {
          logger.import.warn(`[engine] Batch failed after ${MAX_NETWORK_RETRIES} retries — giving up`)
          return batch.rows.map(row => ({
            ok: false,
            error: `Network error after ${MAX_NETWORK_RETRIES} retries: ${error.message}`,
            rowIndex: row.index,
          }))
        }
        logger.import.warn(`[engine] Retryable error during batch: ${error.message}. Pausing for reconnection...`)

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

        // Block until server is reachable again (or abort/skip)
        try {
          await this.connectionMonitor!.waitForConnection(this.fileOrRunSignal())
        } catch {
          // Aborted or file skipped during wait — restore state and return
          if (wasRunning && this.stateMachine.state === ImportState.PAUSED) {
            this.stateMachine.transition(ImportState.RUNNING_FILE)
            run.setState(ImportState.RUNNING_FILE)
            this.workerPool?.resume()
          }
          run.connectionStatus = 'online'
          this.connectionMonitor?.reportOnline()
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

      // Clear transitional UI flags
      if (run.isInitiating) {
        run.isInitiating = false
      }
      if (run.isPausing && (!this.workerPool || this.workerPool.activeWorkerCount === 0)) {
        run.isPausing = false
      }

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
  ): Promise<void> {
    if (this.abortController?.signal.aborted) return

    const run = useRunStore()
    const platform = usePlatformStore()

    const retryable = this.retryQueue.getRetryableRows()
    if (retryable.length === 0) return

    // Use tryTransition to avoid errors if state was reset due to abort
    if (!this.stateMachine.tryTransition(ImportState.RETRYING)) {
      return
    }
    run.setState(ImportState.RETRYING)

    await this.delay(settings.retryDelayMs)

    if (this.abortController?.signal.aborted) return
    if (this.skipFileController?.signal.aborted) return

    // Process retries in single batches (serialized, workers=1)
    // Wrapped with network error handling — same pattern as executeBatchWithMapping()
    const rows = retryable.map(r => r.row)

    const MAX_AUTH_RETRIES = 2
    let authRetryCount = 0
    const MAX_NETWORK_RETRIES = 3
    let networkRetryCount = 0

    let results: BatchResult[]
    while (true) {
      // Check if file was skipped before retrying
      if (this.skipFileController?.signal.aborted) return
      try {
        results = await platform.executeBatch(
          mapping.model,
          rows,
          {
            fieldMappings: mapping.fieldMappings,
            searchKeys: mapping.searchKeys,
            strict: mapping.strict,
          },
          {
            dryRun: settings.dryRun,
            signal: this.abortController?.signal,
            batchAdapter: this.batchSizeAdapter,
          }
        )
        this.connectionMonitor?.reportOnline()
        break
      } catch (error) {
        // Auth error — pause and retry (re-auth may succeed after cooldown)
        if (error instanceof AuthBatchError) {
          authRetryCount++
          if (authRetryCount > MAX_AUTH_RETRIES) {
            logger.import.error('[engine] Authentication failed during retries — stopping import.')
            this.abort()
            return
          }
          logger.import.warn(
            `[engine] Auth error during retries (attempt ${authRetryCount}/${MAX_AUTH_RETRIES}): ${error.message}. Pausing for reconnection...`
          )
          // Fall through to shared reconnection logic below
        }

        // Timeout error — check for idempotency keys before retrying
        if (error instanceof TimeoutBatchError) {
          const hasIdempotencyKey = !!(
            mapping.searchKeys?.length ||
            detectIdColumn(mapping.fieldMappings)
          )
          if (!hasIdempotencyKey) {
            logger.import.warn(
              '[engine] Timeout during retries without idempotency key — failing batch to avoid duplicates'
            )
            return
          }
          logger.import.warn('[engine] Timeout during retries with idempotency key — retrying (upsert-safe)')
          // Fall through to reconnection logic
        }

        if (
          !(error instanceof NetworkBatchError) &&
          !(error instanceof TimeoutBatchError) &&
          !(error instanceof AuthBatchError)
        ) {
          throw error
        }

        // Network/auth/timeout error during retries — pause and wait for reconnection
        networkRetryCount++
        if (networkRetryCount > MAX_NETWORK_RETRIES) {
          logger.import.warn(`[engine] Retries failed after ${MAX_NETWORK_RETRIES} network retries — giving up`)
          return
        }
        logger.import.warn(`[engine] Retryable error during retries: ${error.message}. Pausing for reconnection...`)

        const run = useRunStore()
        this.connectionMonitor?.reportOffline()
        run.connectionStatus = 'offline'

        const wasRetrying = this.stateMachine.state === ImportState.RETRYING
        if (wasRetrying && this.stateMachine.canPause) {
          this.stateMachine.transition(ImportState.PAUSED)
          run.setState(ImportState.PAUSED)
        }

        try {
          await this.connectionMonitor!.waitForConnection(this.fileOrRunSignal())
        } catch {
          // Restore state from PAUSED if skip/abort cancelled the wait
          if (wasRetrying && this.stateMachine.state === ImportState.PAUSED) {
            this.stateMachine.transition(ImportState.RETRYING)
            run.setState(ImportState.RETRYING)
          }
          run.connectionStatus = 'online'
          this.connectionMonitor?.reportOnline()
          return
        }

        // Reconnected — restore state and retry
        run.connectionStatus = 'online'
        if (wasRetrying) {
          if (this.stateMachine.state === ImportState.PAUSED) {
            this.stateMachine.transition(ImportState.RETRYING)
            run.setState(ImportState.RETRYING)
          }
        }
        logger.import.info('[engine] Reconnected during retries. Retrying batch...')
        // Loop continues
      }
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
      const run = useRunStore()
      this.stateMachine.transition(ImportState.PAUSED)
      run.setState(ImportState.PAUSED)
      this.workerPool?.pause()
      // Show "Pausing..." while in-flight batches drain
      if (this.workerPool && this.workerPool.activeWorkerCount > 0) {
        run.isPausing = true
      }
    }
  }

  resume(): void {
    if (this.stateMachine.state === ImportState.PAUSED) {
      const run = useRunStore()
      this.stateMachine.transition(ImportState.RUNNING_FILE)
      run.setState(ImportState.RUNNING_FILE)
      run.isPausing = false
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
    run.isInitiating = false
    run.isPausing = false
    run.isSkipping = false
    run.setState(ImportState.FAILED)
    this.finalizeLog()
  }

  skipCurrentFile(): void {
    if (this.skipFileController && !this.skipFileController.signal.aborted) {
      logger.import.info('Skipping current file...')
      useRunStore().isSkipping = true
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

    // Initialize connection monitor for network error handling
    this.connectionMonitor = new ConnectionMonitor(this.createHealthCheckFn())

    // Initialize retry run
    this.stateMachine.transition(ImportState.VALIDATING)
    run.setState(ImportState.VALIDATING)

    const rowCounts = new Map<string, number>()
    for (const { filename, rowIndices } of filesToRetry) {
      rowCounts.set(filename, rowIndices.size)
    }

    run.initRun(filesToRetry.map(f => f.filename), rowCounts, config.settings.dryRun)
    this.processedIndices.clear()

    if (this.abortController?.signal.aborted) return

    // Create log record for the retry so finalizeLog() can persist it
    const platform = usePlatformStore()
    if (platform.capabilities.serverLogs) {
      try {
        const totalRows = [...rowCounts.values()].reduce((a, b) => a + b, 0)
        this.logId = await createImportLog({
          profile_name: config.activeProfileId ? `Profile #${config.activeProfileId}` : '',
          profile_id: config.activeProfileId ?? undefined,
          is_dry_run: config.settings.dryRun ?? false,
          started_at: new Date().toISOString(),
          filenames: filesToRetry.map(f => f.filename),
          total_rows: totalRows,
        })
        if (this.logId) {
          run.logId = this.logId
        }
      } catch (err) {
        logger.import.warn('Failed to create import log for retry', { error: (err as Error).message })
      }

      this.startHeartbeat()
    }

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

        // Execute batch with network error retry (same pattern as executeBatchWithMapping)
        const platform = usePlatformStore()
        const effectiveSize = Math.max(
          platform.batchSizeRange.min,
          Math.min(platform.batchSizeRange.max, config.settings.batchSize)
        )
        const retryAdapter = platform.createBatchAdapter?.(effectiveSize) ?? undefined

        const MAX_AUTH_RETRIES = 2
        let authRetryCount = 0
        const MAX_NETWORK_RETRIES = 3
        let networkRetryCount = 0

        let results: BatchResult[] | undefined
        while (true) {
          try {
            results = await platform.executeBatch(
              mapping.model,
              rows,
              {
                fieldMappings: mapping.fieldMappings,
                searchKeys: mapping.searchKeys,
                strict: mapping.strict,
              },
              {
                dryRun: config.settings.dryRun,
                signal: this.abortController?.signal,
                batchAdapter: retryAdapter,
              }
            )
            this.connectionMonitor?.reportOnline()
            break
          } catch (error) {
            // Auth error — pause and retry (re-auth may succeed after cooldown)
            if (error instanceof AuthBatchError) {
              authRetryCount++
              if (authRetryCount > MAX_AUTH_RETRIES) {
                logger.import.error('[retry] Authentication failed after retries — stopping import.')
                results = rows.map(row => ({
                  ok: false,
                  error: 'Authentication failed: ' + error.message,
                  rowIndex: row.index,
                }))
                this.abort()
                break
              }
              logger.import.warn(
                `[retry] Auth error (attempt ${authRetryCount}/${MAX_AUTH_RETRIES}): ${error.message}. Pausing for reconnection...`
              )
              // Fall through to shared reconnection logic below
            }

            // Timeout error — check for idempotency keys before retrying
            if (error instanceof TimeoutBatchError) {
              const hasIdempotencyKey = !!(
                mapping.searchKeys?.length ||
                detectIdColumn(mapping.fieldMappings)
              )
              if (!hasIdempotencyKey) {
                logger.import.warn(
                  '[retry] Timeout without idempotency key — failing batch to avoid duplicates'
                )
                results = rows.map(row => ({
                  ok: false,
                  error: 'Request timed out. Add external IDs or search keys to enable safe retry.',
                  rowIndex: row.index,
                }))
                break
              }
              logger.import.warn('[retry] Timeout with idempotency key — retrying (upsert-safe)')
              // Fall through to reconnection logic
            }

            if (
              !(error instanceof NetworkBatchError) &&
              !(error instanceof TimeoutBatchError) &&
              !(error instanceof AuthBatchError)
            ) {
              throw error
            }

            // Network/auth/timeout error — pause and wait for reconnection
            networkRetryCount++
            if (networkRetryCount > MAX_NETWORK_RETRIES) {
              logger.import.warn(`[retry] Batch failed after ${MAX_NETWORK_RETRIES} retries — giving up`)
              results = rows.map(row => ({
                ok: false,
                error: `Network error after ${MAX_NETWORK_RETRIES} retries: ${error.message}`,
                rowIndex: row.index,
              }))
              break
            }
            logger.import.warn(`[retry] Retryable error: ${error.message}. Waiting for reconnection...`)
            this.connectionMonitor?.reportOffline()
            run.connectionStatus = 'offline'

            const wasRunning = this.stateMachine.canPause
            if (wasRunning) {
              this.stateMachine.transition(ImportState.PAUSED)
              run.setState(ImportState.PAUSED)
            }

            try {
              await this.connectionMonitor!.waitForConnection(this.abortController?.signal)
            } catch {
              // Aborted during wait — let the outer abort check handle it
              break
            }

            run.connectionStatus = 'online'
            if (wasRunning && this.stateMachine.state === ImportState.PAUSED) {
              this.stateMachine.transition(ImportState.RUNNING_FILE)
              run.setState(ImportState.RUNNING_FILE)
            }
            logger.import.info('[retry] Reconnected. Retrying batch...')
          }
        }

        if (this.abortController?.signal.aborted) break
        if (!results) continue

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

        // Track processed indices for log lifecycle
        if (!this.processedIndices.has(filename)) {
          this.processedIndices.set(filename, new Set())
        }
        const fileIndices = this.processedIndices.get(filename)!
        for (const result of results) {
          fileIndices.add(result.rowIndex)
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
        run.completeFile(filename)
      }
    }

    // Clean up connection monitor
    this.connectionMonitor?.destroy()
    this.connectionMonitor = null

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

  /**
   * Create a combined AbortSignal that fires when EITHER the run-level
   * abortController OR the file-level skipFileController is triggered.
   * This allows waitForConnection() to be cancelled by a file skip.
   */
  private fileOrRunSignal(): AbortSignal | undefined {
    const run = this.abortController?.signal
    const skip = this.skipFileController?.signal
    if (!run && !skip) return undefined
    if (!skip) return run
    if (!run) return skip
    if (run.aborted || skip.aborted) {
      const c = new AbortController()
      c.abort()
      return c.signal
    }
    const combined = new AbortController()
    const onAbort = () => combined.abort()
    run.addEventListener('abort', onAbort, { once: true })
    skip.addEventListener('abort', onAbort, { once: true })
    return combined.signal
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.fileOrRunSignal()
      if (signal?.aborted) {
        resolve()
        return
      }

      const timeout = setTimeout(resolve, ms)

      // Clean up if aborted or file skipped during delay
      signal?.addEventListener('abort', () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
    })
  }

  /**
   * Create a health check function appropriate for the current import mode.
   * - Embedded mode: uses the default same-origin fetch to /ametras_fast_import/info
   * - Standalone mode: uses window.api.odoo.ping (session-free server reachability check)
   *
   * The standalone health check intentionally bypasses session validation.
   * During long outages the session may expire (30 min TTL), so using
   * odoo:call would return "Session expired" even when the server is back,
   * preventing reconnection forever.
   */
  private createHealthCheckFn(): HealthCheckFn | undefined {
    const session = useSessionStore()
    if (session.isEmbedded) {
      // Embedded mode: use the default health check (same-origin fetch)
      return undefined
    }
    // Standalone/Electron mode: lightweight ping without session validation
    const baseUrl = session.baseUrl
    return async () => {
      try {
        const result = await window.api.odoo.ping(baseUrl || '')
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
   */
  private finalizeLog(): void {
    this.stopHeartbeat()
    const run = useRunStore()

    const files = Object.values(run.progress.files)
    const totalRows = files.reduce((sum, f) => sum + f.totalRows, 0)
    const successRows = files.reduce((sum, f) => sum + f.successCount, 0)
    const failedRows = files.reduce((sum, f) => sum + f.failedCount, 0)

    const finishedAt = new Date().toISOString()

    const errorLog = run.errors.map(e => ({
      filename: e.filename,
      rowNumber: e.rowNumber,
      error: e.error,
    }))

    const state = failedRows > 0 ? 'failed' as const : 'completed' as const

    if (this.logId) {
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
