import { useSessionStore } from '@/stores/session'
import type { ParsedRow } from './csvParser'
import type { BatchSizeAdapter } from './batchSizeAdapter'
import { transformRowData } from '@/utils/rowTransform'

/**
 * Dynamic request timeout for addon import calls.
 * Formula: clamp(BASE + PER_ROW * rowCount, MIN, MAX)
 * Addon processes rows individually with savepoints (lighter per row than standalone).
 */
const IMPORT_TIMEOUT_BASE_MS = 10_000   // 10s base (network round-trip + ORM setup)
const IMPORT_TIMEOUT_PER_ROW_MS = 300   // 300ms per row (savepoint-based, lighter)
const IMPORT_TIMEOUT_MIN_MS = 15_000    // 15s floor (protects slow individual rows)
const IMPORT_TIMEOUT_MAX_MS = 120_000   // 120s cap (prevents unbounded waits)

function computeImportTimeout(rowCount: number): number {
  const raw = IMPORT_TIMEOUT_BASE_MS + IMPORT_TIMEOUT_PER_ROW_MS * rowCount
  return Math.max(IMPORT_TIMEOUT_MIN_MS, Math.min(IMPORT_TIMEOUT_MAX_MS, raw))
}

/**
 * Error thrown when a batch fails due to a network/transient issue.
 * The rows are NOT marked as failed — they should be retried after reconnection.
 */
export class NetworkBatchError extends Error {
  readonly rows: ParsedRow[]
  constructor(message: string, rows: ParsedRow[]) {
    super(message)
    this.name = 'NetworkBatchError'
    this.rows = rows
  }
}

/**
 * Error thrown when a batch fails due to an authentication issue.
 * The import should STOP immediately — all subsequent batches would also fail.
 */
export class AuthBatchError extends Error {
  readonly rows: ParsedRow[]
  constructor(message: string, rows: ParsedRow[]) {
    super(message)
    this.name = 'AuthBatchError'
    this.rows = rows
  }
}

/**
 * Error thrown when a batch times out.
 * The server may have already committed the rows — retrying without
 * idempotency keys (external IDs / search keys) risks creating duplicates.
 */
export class TimeoutBatchError extends Error {
  readonly rows: ParsedRow[]
  constructor(message: string, rows: ParsedRow[]) {
    super(message)
    this.name = 'TimeoutBatchError'
    this.rows = rows
  }
}

export interface BatchResult {
  ok: boolean
  error?: string
  rowIndex: number
  createdId?: number
  externalId?: string
}

export interface RowState {
  rowIndex: number
  attempts: number
  lastError?: string
  status: 'pending' | 'success' | 'failed' | 'retrying'
}

/**
 * Detect which ID column is being used for upsert based on fieldMappings.
 * Returns 'id' for external ID, '.id' for database ID, or null if neither.
 *
 * Note: Any CSV column can be mapped to 'id' or '.id' - we check the target field,
 * not the source column name.
 */
export function detectIdColumn(fieldMappings: Record<string, string>): 'id' | '.id' | null {
  for (const odooField of Object.values(fieldMappings)) {
    if (odooField === 'id') return 'id'
    if (odooField === '.id') return '.id'
  }
  return null
}

function transformRow(
  row: ParsedRow,
  mapping: { fieldMappings: Record<string, string> }
): Record<string, string | number> {
  return transformRowData(row.data, mapping.fieldMappings)
}

export interface MappingConfig {
  fieldMappings: Record<string, string>
  idColumn?: 'id' | '.id' | null
  /** Field names for natural key search (Strategy 2) */
  searchKeys?: string[]
  /** If true, fail on missing keys instead of falling back to create */
  strict?: boolean
}

/**
 * Send a single sub-batch to the addon endpoint.
 */
async function executeSubBatch(
  model: string,
  rows: ParsedRow[],
  mapping: MappingConfig,
  dryRun: boolean,
): Promise<BatchResult[]> {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')
  const db = session.currentServer?.db

  // Detect ID column from fieldMappings if not explicitly provided
  const idColumn = mapping.idColumn ?? detectIdColumn(mapping.fieldMappings)

  const transformedRows = rows.map(row => ({
    index: row.index,
    data: transformRow(row, mapping)
  }))

  const response = await window.api.odoo.call<{
    results: Array<{
      ok: boolean
      error?: string
      id?: number
      external_id?: string
      action?: 'created' | 'updated' | 'skipped'
      strategy?: string
    }>
  }>({
    baseUrl: session.baseUrl,
    db,
    endpoint: '/ametras_fast_import/run',
    params: {
      model,
      rows: transformedRows.map(r => r.data),
      use_external_id: idColumn === 'id',
      search_keys: mapping.searchKeys || null,
      dry_run: dryRun || false,
      strict: mapping.strict || false
    },
    timeout: computeImportTimeout(rows.length)
  })

  if (!response.ok || !response.result) {
    // Auth errors: stop the import immediately — all subsequent batches would also fail
    if (response.errorCode === 'AUTH_ERROR') {
      throw new AuthBatchError(response.error || 'Authentication failed', rows)
    }
    // Timeout errors: server may have committed — need idempotency check before retry
    if (response.errorCode === 'TIMEOUT') {
      throw new TimeoutBatchError(response.error || 'Request timed out', rows)
    }
    // Network/transient errors: throw so the engine can pause and retry
    if (response.errorCode === 'NETWORK_ERROR') {
      throw new NetworkBatchError(response.error || 'Network error', rows)
    }

    // Data/other errors: return all rows as failed
    return rows.map((_row, idx) => ({
      ok: false,
      error: response.error || 'Request failed',
      rowIndex: rows[idx].index
    }))
  }

  return response.result.results.map((r, idx) => ({
    ok: r.ok,
    error: r.error,
    rowIndex: rows[idx].index,
    createdId: r.id,
    externalId: r.external_id
  }))
}

/**
 * Execute a batch of rows via the addon endpoint.
 * When a BatchSizeAdapter is provided, splits into sub-batches and
 * adapts the size on timeout (step-down) or success (step-up).
 */
export async function executeBatch(
  model: string,
  rows: ParsedRow[],
  mapping: MappingConfig,
  dryRun?: boolean,
  adapter?: BatchSizeAdapter,
): Promise<BatchResult[]> {
  if (!adapter) {
    return executeSubBatch(model, rows, mapping, dryRun || false)
  }

  const allResults: BatchResult[] = []
  let offset = 0

  while (offset < rows.length) {
    const chunkSize = adapter.currentSize
    const chunk = rows.slice(offset, offset + chunkSize)

    try {
      const results = await executeSubBatch(model, chunk, mapping, dryRun || false)
      adapter.recordSuccess(chunk.length)
      allResults.push(...results)
    } catch (err) {
      if (err instanceof TimeoutBatchError) {
        adapter.recordTimeout()
      }
      throw err
    }

    offset += chunk.length
  }

  return allResults
}

