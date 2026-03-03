/**
 * Standalone batch executor.
 * Executes CSV imports directly via Odoo's model.load() API
 * without requiring the ametras_fast_import addon.
 *
 * Features:
 * - Adaptive retry: splits failed batches to isolate failing rows
 * - Batch size restricted to 10-200 for stability
 */

import { useSessionStore } from '@/stores/session'
import type { ParsedRow } from '@/importer/csvParser'
import type { BatchResult, MappingConfig } from '@/importer/batchExecutor'
import { detectIdColumn, NetworkBatchError } from '@/importer/batchExecutor'
import { logger } from '@/utils/logger'

// Batch size constraints for standalone mode
export const STANDALONE_MIN_BATCH_SIZE = 10
export const STANDALONE_MAX_BATCH_SIZE = 100
export const STANDALONE_DEFAULT_BATCH_SIZE = 50

/**
 * Warmup-based adaptive batch size controller.
 * Starts at size 1 (single rows) to learn data quality, then steps up
 * through fixed levels: 1 → 10 → maxSize.
 *
 * Increase: after 100 consecutive successful rows, step up one level.
 * Decrease: after 3 consecutive failed batches, step down one level.
 * Each file starts fresh at level 0 (size 1).
 */
export class BatchSizeAdapter {
  currentSize: number
  private levels: number[]
  private levelIndex: number = 0
  private successfulRows: number = 0
  private consecutiveFailures: number = 0

  static readonly SUCCESS_THRESHOLD = 30
  static readonly FAILURE_THRESHOLD = 3

  constructor(maxSize: number = STANDALONE_MAX_BATCH_SIZE) {
    // Build levels: [1, min(10, max), max] deduplicated
    const raw = [1, Math.min(10, maxSize), maxSize]
    this.levels = [...new Set(raw)].sort((a, b) => a - b)
    this.levelIndex = 0
    this.currentSize = this.levels[0]
  }

  /** Record successful rows and step up after enough consecutive successes. */
  recordSuccess(rowCount: number): void {
    this.consecutiveFailures = 0
    this.successfulRows += rowCount
    if (this.successfulRows >= BatchSizeAdapter.SUCCESS_THRESHOLD && this.levelIndex < this.levels.length - 1) {
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
}

// Concurrency retry settings
export const CONCURRENCY_MAX_RETRIES = 3
const CONCURRENCY_BASE_DELAY_MS = 500
const CONCURRENCY_MAX_DELAY_MS = 5000

/**
 * Error thrown when a batch fails due to a database concurrency issue
 * (deadlock, serialization failure, duplicate key race).
 * These are transient and safe to retry with backoff.
 */
export class ConcurrencyBatchError extends Error {
  readonly rows: ParsedRow[]
  constructor(message: string, rows: ParsedRow[]) {
    super(message)
    this.name = 'ConcurrencyBatchError'
    this.rows = rows
  }
}

/** Full-jitter exponential backoff delay for concurrency retries. */
function concurrencyBackoffDelay(attempt: number): number {
  const cap = Math.min(CONCURRENCY_MAX_DELAY_MS, CONCURRENCY_BASE_DELAY_MS * Math.pow(2, attempt))
  return Math.random() * cap
}

// Adaptive retry settings
export const DEFAULT_RETRY_DEPTH = 3  // Number of granularity levels (e.g. 3 = 100 → 10 → 1)
const RETRY_SPLIT_DELAY_MS = 200  // Delay between split retries to avoid overwhelming the server

/**
 * Abort-aware delay. Resolves immediately if signal is already aborted
 * or fires during the wait.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(r => setTimeout(r, ms))
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const onAbort = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Transform a row for Odoo's load() format.
 * Returns values in the order matching the header array.
 */
function transformRowForLoad(
  row: ParsedRow,
  mapping: MappingConfig,
  headerOrder: string[]
): string[] {
  // Returns all values as strings - Odoo's load() API handles type conversion internally
  const result: string[] = []

  for (const odooField of headerOrder) {
    // Find the CSV column that maps to this Odoo field
    let value: string | null = null

    for (const [csvCol, targetField] of Object.entries(mapping.fieldMappings)) {
      if (targetField === odooField) {
        const csvValue = row.data[csvCol]
        if (csvValue !== undefined && csvValue !== '') {
          // Always keep values as strings - Odoo's load() handles type conversion
          value = csvValue
        }
        break
      }
    }

    result.push(value ?? '')
  }

  return result
}

/**
 * Build Odoo-compatible header from field mappings.
 * Converts internal field names to Odoo's load() format.
 */
function buildOdooHeader(mapping: MappingConfig): string[] {
  const header: string[] = []
  const seen = new Set<string>()

  // Detect ambiguous mappings: multiple CSV columns targeting the same Odoo field
  const fieldSources = new Map<string, string[]>()
  for (const [csvCol, odooField] of Object.entries(mapping.fieldMappings)) {
    if (!fieldSources.has(odooField)) {
      fieldSources.set(odooField, [])
    }
    fieldSources.get(odooField)!.push(csvCol)
  }
  for (const [odooField, csvCols] of fieldSources) {
    if (csvCols.length > 1) {
      logger.import.warn(
        `[standalone] Ambiguous mapping: CSV columns [${csvCols.join(', ')}] all map to "${odooField}". Only the first column ("${csvCols[0]}") will be used.`
      )
    }
  }

  for (const odooField of Object.values(mapping.fieldMappings)) {
    // Skip duplicates
    if (seen.has(odooField)) continue
    seen.add(odooField)

    // Convert our internal format to Odoo's load() format
    if (odooField === 'id') {
      // External ID column - Odoo uses 'id' for external IDs in load()
      header.push('id')
    } else if (odooField === '.id') {
      // Database ID column
      header.push('.id')
    } else if (odooField === '__op__') {
      // Skip operation column - not supported in standalone mode
      continue
    } else if (odooField.endsWith('/id')) {
      // Relational field with external ID reference
      // e.g., country_id/id -> country_id/id (same format)
      header.push(odooField)
    } else if (odooField.endsWith('/.id')) {
      // Relational field with database ID reference
      // e.g., country_id/.id -> country_id/.id (same format)
      header.push(odooField)
    } else {
      // Regular field
      header.push(odooField)
    }
  }

  return header
}

/**
 * Internal: Execute a single batch without retry logic.
 */
async function executeLoadBatch(
  baseUrl: string,
  db: string,
  model: string,
  header: string[],
  rows: ParsedRow[],
  mapping: MappingConfig,
  signal?: AbortSignal
): Promise<{ ok: boolean; results: BatchResult[]; errorRowIndices?: Set<number> }> {
  if (signal?.aborted) {
    return {
      ok: false,
      results: rows.map(row => ({ ok: false, error: 'Aborted', rowIndex: row.index })),
    }
  }

  const loadRows = rows.map(row => transformRowForLoad(row, mapping, header))

  const response = await window.api.standalone.load({
    baseUrl,
    db,
    model,
    header,
    rows: loadRows
  })

  if (!response.ok) {
    // Widen errorCode to avoid stale project-reference type narrowing
    const errorCode: string | undefined = response.errorCode

    // Network/transient errors: throw so the engine can pause and retry
    if (errorCode === 'NETWORK_ERROR' || errorCode === 'TIMEOUT') {
      throw new NetworkBatchError(response.error || 'Network error', rows)
    }

    // Concurrency errors: throw so the caller can retry with backoff
    if (errorCode === 'CONCURRENCY_ERROR') {
      throw new ConcurrencyBatchError(response.error || 'Concurrency error', rows)
    }

    // Entire batch failed, but try to extract per-row errors from messages
    const messages = response.messages || []
    const errorMap = new Map<number, string>()
    for (const msg of messages) {
      if (msg.record !== undefined) {
        errorMap.set(msg.record, msg.message)
      }
    }

    // Build results with per-row errors if available, otherwise use generic error
    const genericError = response.error || 'Import failed'
    // Collect batch-local indices that Odoo explicitly flagged as bad
    const errorRowIndices = errorMap.size > 0 ? new Set(errorMap.keys()) : undefined
    return {
      ok: false,
      results: rows.map((row, idx) => ({
        ok: false,
        error: errorMap.get(idx) || genericError,
        rowIndex: row.index
      })),
      errorRowIndices
    }
  }

  // Process results
  const results: BatchResult[] = []
  const ids = response.ids || []
  const messages = response.messages || []

  // Build error map from messages
  const errorMap = new Map<number, string>()
  for (const msg of messages) {
    if (msg.record !== undefined && typeof msg.record === 'number' && msg.record >= 0 && msg.record < rows.length) {
      errorMap.set(msg.record, msg.message)
    }
  }

  // Only map IDs by index when counts match — a mismatch means Odoo
  // skipped rows, making index-based attribution unreliable.
  const idsAligned = ids.length === rows.length

  if (ids.length > 0 && !idsAligned) {
    logger.import.warn(
      `[standalone] Response ID count (${ids.length}) doesn't match rows sent (${rows.length}). ` +
      `Skipping per-row ID assignment to avoid misattribution.`
    )
  }

  for (let i = 0; i < rows.length; i++) {
    const hasError = errorMap.has(i)
    const createdId = idsAligned && i < ids.length ? ids[i] : undefined
    const ok = !hasError && (idsAligned ? createdId !== undefined : ids.length > 0)

    results.push({
      ok,
      error: errorMap.get(i),
      rowIndex: rows[i].index,
      createdId
    })
  }

  return { ok: true, results }
}

/**
 * Compute the chunk size for a given retry depth level.
 * Uses geometric progression from initialSize down to 1.
 *
 * Examples with retryDepth=3 (3 granularity levels):
 *   initialSize=100: level 0→100, level 1→10, level 2→1
 *   initialSize=60:  level 0→60,  level 1→8,  level 2→1
 *
 * Examples with retryDepth=4:
 *   initialSize=200: level 0→200, level 1→34, level 2→6, level 3→1
 */
function computeRetryChunkSize(initialSize: number, depth: number, retryDepth: number): number {
  if (retryDepth <= 1 || depth <= 0) return initialSize
  if (depth >= retryDepth - 1) return 1
  const ratio = (retryDepth - 1 - depth) / (retryDepth - 1)
  return Math.max(1, Math.round(Math.pow(initialSize, ratio)))
}

/**
 * Adaptive retry: splits failed batches into progressively smaller chunks
 * to isolate failing rows.
 *
 * The splitting follows a geometric progression based on retryDepth:
 *   retryDepth=3, batch=100  →  100 / 10 / 1
 *   retryDepth=3, batch=60   →  60 / 8 / 1
 *
 * When per-row error info is available from Odoo, known-bad rows are
 * failed immediately and only the remaining rows are retried.
 *
 * The bottom level is always single rows — no "max depth exceeded" errors.
 */
async function executeWithAdaptiveRetry(
  baseUrl: string,
  db: string,
  model: string,
  header: string[],
  rows: ParsedRow[],
  mapping: MappingConfig,
  depth: number = 0,
  initialBatchSize: number,
  retryDepth: number = DEFAULT_RETRY_DEPTH,
  signal?: AbortSignal
): Promise<BatchResult[]> {
  // Check abort before doing any work
  if (signal?.aborted) {
    return rows.map(row => ({ ok: false, error: 'Aborted', rowIndex: row.index }))
  }

  // Try the batch — with concurrency retry (backoff + jitter) before falling through to splitting
  let result: Awaited<ReturnType<typeof executeLoadBatch>>
  for (let attempt = 0; ; attempt++) {
    try {
      result = await executeLoadBatch(baseUrl, db, model, header, rows, mapping, signal)
      break // no concurrency error — proceed
    } catch (err) {
      if (err instanceof ConcurrencyBatchError) {
        if (attempt < CONCURRENCY_MAX_RETRIES - 1) {
          const delay = concurrencyBackoffDelay(attempt)
          logger.import.warn(
            `[standalone] Concurrency error (attempt ${attempt + 1}/${CONCURRENCY_MAX_RETRIES}), ` +
            `retrying in ${Math.round(delay)}ms: ${err.message}`
          )
          await abortableDelay(delay, signal)
          if (signal?.aborted) {
            return rows.map(row => ({ ok: false, error: 'Aborted', rowIndex: row.index }))
          }
          continue
        }
        // Exhausted retries — fall through to adaptive retry (batch splitting)
        logger.import.warn(
          `[standalone] Concurrency error persisted after ${CONCURRENCY_MAX_RETRIES} attempts, falling through to batch splitting`
        )
        result = {
          ok: false,
          results: rows.map(row => ({ ok: false, error: err.message, rowIndex: row.index })),
        }
        break
      }
      throw err // re-throw NetworkBatchError and others
    }
  }

  // Check abort after API call
  if (signal?.aborted) {
    return rows.map(row => ({ ok: false, error: 'Aborted', rowIndex: row.index }))
  }

  // Success — return as-is
  if (result.ok) {
    return result.results
  }

  // Single row — nothing to split, return the actual Odoo error
  if (rows.length <= 1) {
    return result.results
  }

  // At the deepest retry level — no more splitting possible, return errors
  if (depth >= retryDepth - 1) {
    return result.results
  }

  // Determine which rows need retrying
  let rowsToRetry: ParsedRow[]
  const immediateFailResults: BatchResult[] = []

  // Error-guided: if Odoo told us which rows are bad, skip them
  if (result.errorRowIndices && result.errorRowIndices.size > 0 && result.errorRowIndices.size < rows.length) {
    const goodRows: ParsedRow[] = []
    for (let i = 0; i < rows.length; i++) {
      if (result.errorRowIndices.has(i)) {
        immediateFailResults.push(result.results[i])
      } else {
        goodRows.push(rows[i])
      }
    }
    rowsToRetry = goodRows

    logger.import.info(
      `[standalone] Batch of ${rows.length} failed: ${immediateFailResults.length} known-bad, retrying ${rowsToRetry.length} rows`
    )
  } else {
    rowsToRetry = rows
  }

  if (rowsToRetry.length === 0) return immediateFailResults

  // Compute chunk size for next depth level
  const nextChunkSize = computeRetryChunkSize(initialBatchSize, depth + 1, retryDepth)

  logger.import.info(
    `[standalone] Retrying ${rowsToRetry.length} rows in chunks of ${nextChunkSize} (depth ${depth + 1}/${retryDepth - 1})`
  )

  // Split into chunks and retry each
  const retryResults: BatchResult[] = []
  for (let i = 0; i < rowsToRetry.length; i += nextChunkSize) {
    if (signal?.aborted) {
      for (let j = i; j < rowsToRetry.length; j++) {
        retryResults.push({ ok: false, error: 'Aborted', rowIndex: rowsToRetry[j].index })
      }
      break
    }

    await abortableDelay(RETRY_SPLIT_DELAY_MS, signal)
    const chunk = rowsToRetry.slice(i, i + nextChunkSize)
    const chunkResults = await executeWithAdaptiveRetry(
      baseUrl, db, model, header, chunk, mapping,
      depth + 1, initialBatchSize, retryDepth, signal
    )
    retryResults.push(...chunkResults)
  }

  return [...immediateFailResults, ...retryResults]
}

/**
 * Execute a batch of rows using standalone mode (direct model.load()).
 * Features adaptive retry that splits failed batches to isolate failing rows.
 */
export async function executeStandaloneBatch(
  model: string,
  rows: ParsedRow[],
  mapping: MappingConfig,
  dryRun?: boolean,
  signal?: AbortSignal,
  adapter?: BatchSizeAdapter,
  retryDepth: number = DEFAULT_RETRY_DEPTH
): Promise<BatchResult[]> {
  if (dryRun) {
    throw new Error('Dry-run is not supported in standalone mode. Disable dry-run or install the ametras_fast_import addon.')
  }

  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')
  const db = session.currentServer?.db
  if (!db) throw new Error('No database selected')


  logger.import.debug(`[standalone] Executing batch: ${rows.length} rows for ${model}`)

  // Build Odoo-compatible header
  const header = buildOdooHeader(mapping)

  // Execute with adaptive retry for better error isolation
  // When an adapter is provided, process rows in sub-batches of adapter.currentSize
  const allResults: BatchResult[] = []

  if (adapter) {
    let offset = 0
    while (offset < rows.length) {
      if (signal?.aborted) {
        // Mark remaining rows as aborted
        for (let i = offset; i < rows.length; i++) {
          allResults.push({ ok: false, error: 'Aborted', rowIndex: rows[i].index })
        }
        break
      }

      const chunkSize = adapter.currentSize
      const chunk = rows.slice(offset, offset + chunkSize)

      const chunkResults = await executeWithAdaptiveRetry(
        session.baseUrl, db, model, header, chunk, mapping, 0, chunkSize, retryDepth, signal
      )

      // Update adapter based on outcome
      const hadFailure = chunkResults.some(r => !r.ok)
      if (hadFailure) {
        adapter.recordFailure()
      } else {
        adapter.recordSuccess(chunk.length)
      }

      allResults.push(...chunkResults)
      offset += chunk.length
    }
  } else {
    // No adapter — send all rows at once (original behavior)
    const results = await executeWithAdaptiveRetry(
      session.baseUrl, db, model, header, rows, mapping, 0, rows.length, retryDepth, signal
    )
    allResults.push(...results)
  }

  // Log summary
  const successCount = allResults.filter(r => r.ok).length
  const failCount = allResults.length - successCount


  logger.import.info(`[standalone] Batch complete for ${model}: ${successCount} success, ${failCount} failed`)

  // Log individual failures
  for (const result of allResults) {
    if (!result.ok && result.error) {
      logger.import.warn(`[standalone] Row ${result.rowIndex}: ${result.error}`)
    }
  }

  return allResults
}

/**
 * Standalone batch executor class.
 * Provides the same interface as the addon-based executor.
 */
export class StandaloneBatchExecutor {
  private model: string
  private mapping: MappingConfig

  constructor(model: string, mapping: MappingConfig) {
    this.model = model
    this.mapping = mapping

    // Detect ID column if not provided
    if (this.mapping.idColumn === undefined) {
      this.mapping.idColumn = detectIdColumn(mapping.fieldMappings)
    }
  }

  async execute(rows: ParsedRow[], dryRun?: boolean, signal?: AbortSignal): Promise<BatchResult[]> {
    if (dryRun) {
      throw new Error('Dry-run is not supported in standalone mode. Disable dry-run or install the ametras_fast_import addon.')
    }
    return executeStandaloneBatch(this.model, rows, this.mapping, undefined, signal)
  }
}
