import { useSessionStore } from '@/stores/session'
import type { ParsedRow } from './csvParser'
import type { FieldMapping, FieldTransform } from '@/types/fieldMapping'

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
  // New implementation: Check if ANY CSV column is mapped to 'id' or '.id'
  for (const odooField of Object.values(fieldMappings)) {
    if (odooField === 'id') return 'id'
    if (odooField === '.id') return '.id'
  }

  // Old implementation (fallback - only works if CSV column is literally named 'id' or '.id'):
  // if (fieldMappings['id'] === 'id') return 'id'
  // if (fieldMappings['.id'] === '.id') return '.id'

  return null
}

function transformRow(
  row: ParsedRow,
  mapping: { fieldMappings: Record<string, string> }
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [csvCol, odooField] of Object.entries(mapping.fieldMappings)) {
    const value = row.data[csvCol]
    if (value === undefined || value === '') continue

    // Handle id/.id fields specially for upsert
    // Any CSV column can be mapped to 'id' (external ID) or '.id' (database ID)
    if (odooField === 'id') {
      result['__external_id__'] = value
      continue
    }
    if (odooField === '.id') {
      result['id'] = parseInt(value, 10)
      continue
    }

    // Old implementation (fallback - only works if CSV column is literally named 'id' or '.id'):
    // if (csvCol === 'id' && odooField === 'id') {
    //   result['__external_id__'] = value
    //   continue
    // }
    // if (csvCol === '.id' && odooField === '.id') {
    //   result['id'] = parseInt(value, 10)
    //   continue
    // }

    // Handle operation column for Strategy 3: Explicit Operation
    if (odooField === '__op__') {
      result['__op__'] = value
      continue
    }

    // Handle reference suffixes: /id for external ID, /.id for database ID
    if (odooField.endsWith('/.id')) {
      const targetField = odooField.slice(0, -4)
      result[targetField] = parseInt(value, 10)
      continue
    }
    if (odooField.endsWith('/id')) {
      const targetField = odooField.slice(0, -3)
      result[targetField] = value
      continue
    }

    result[odooField] = value
  }

  return result
}

export interface MappingConfig {
  fieldMappings: Record<string, string>
  idColumn?: 'id' | '.id' | null
  /** Field names for natural key search (Strategy 2) */
  searchKeys?: string[]
  /** If true, fail on missing keys instead of falling back to create */
  strict?: boolean
  /** Use legacy threaded import (Odoo standard load via import_threaded) */
  legacyImport?: boolean
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
    endpoint: '/csv_import/run',
    params: {
      model,
      rows: transformedRows.map(r => r.data),
      use_external_id: idColumn === 'id',
      search_keys: mapping.searchKeys || null,
      dry_run: dryRun || false,
      strict: mapping.strict || false,
      use_legacy: mapping.legacyImport || false
    }
  })

  if (!response.ok) {
    // Return all rows as failed if the entire request failed
    return rows.map((_row, idx) => ({
      ok: false,
      error: response.error || 'Request failed',
      rowIndex: rows[idx].index
    }))
  }

  return response.result!.results.map((r, idx) => ({
    ok: r.ok,
    error: r.error,
    rowIndex: rows[idx].index,
    createdId: r.id,
    externalId: r.external_id
  }))
}

/**
 * Transform CSV row to Odoo vals using rich field mappings.
 */
export function transformRowWithMappings(
  row: ParsedRow,
  mappings: FieldMapping[],
  filename: string
): Record<string, unknown> {
  const fileMappings = mappings.filter(m => m.filename === filename)
  const vals: Record<string, unknown> = {}

  for (const mapping of fileMappings) {
    const csvValue = row.data[mapping.csvHeader]

    // Skip empty values (let Odoo defaults apply)
    if (csvValue === undefined || csvValue === '') continue

    // Apply transform
    vals[mapping.odooField] = applyTransform(csvValue, mapping.transform)
  }

  return vals
}

/**
 * Apply field transform to value.
 * Reference resolution happens on the backend; frontend just prepares the values.
 */
function applyTransform(value: string, transform: FieldTransform): unknown {
  switch (transform.type) {
    case 'passthrough':
      return value

    case 'm2o_ref':
      // Return as external ID reference string for backend resolution
      return value

    case 'm2m_ref':
      // Return as pipe-delimited external ID references for backend resolution
      // Backend will parse and resolve to [(6, 0, [ids])]
      return value

    case 'db_id':
      // Convert to integer - backend validates record exists in allowed models
      return parseInt(value, 10)

    default:
      return value
  }
}

/**
 * Validate row against required mappings.
 */
export function validateRowRequiredFields(
  row: ParsedRow,
  mappings: FieldMapping[],
  filename: string
): { valid: boolean; missingFields: string[] } {
  const fileMappings = mappings.filter(m => m.filename === filename)
  const requiredMappings = fileMappings.filter(m => m.required)

  const missingFields: string[] = []

  for (const mapping of requiredMappings) {
    const value = row.data[mapping.csvHeader]
    if (value === undefined || value === '') {
      missingFields.push(mapping.csvHeader)
    }
  }

  return {
    valid: missingFields.length === 0,
    missingFields
  }
}

export function* batchRows<T>(rows: T[], batchSize: number): Generator<T[]> {
  for (let i = 0; i < rows.length; i += batchSize) {
    yield rows.slice(i, i + batchSize)
  }
}
