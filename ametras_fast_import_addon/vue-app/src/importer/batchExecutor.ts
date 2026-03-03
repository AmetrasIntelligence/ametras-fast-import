import { useSessionStore } from '@/stores/session'
import type { ParsedRow } from './csvParser'
import { transformRowData } from '@/utils/rowTransform'

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

export async function executeBatch(
  model: string,
  rows: ParsedRow[],
  mapping: MappingConfig,
  dryRun?: boolean
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
    }
  })

  if (!response.ok || !response.result) {
    // Network/transient errors: throw so the engine can pause and retry
    if (response.errorCode === 'NETWORK_ERROR' || response.errorCode === 'TIMEOUT') {
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

