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
 */
export function detectIdColumn(fieldMappings: Record<string, string>): 'id' | '.id' | null {
  // Check if 'id' CSV column is mapped to 'id' (external ID for upsert)
  if (fieldMappings['id'] === 'id') return 'id'
  // Check if '.id' CSV column is mapped to '.id' (database ID for upsert)
  if (fieldMappings['.id'] === '.id') return '.id'
  return null
}

function transformRow(
  row: ParsedRow,
  mapping: { fieldMappings: Record<string, string> }
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [csvCol, odooField] of Object.entries(mapping.fieldMappings)) {
    // Handle id/.id columns specially for upsert (Strategy 1: External ID)
    if (csvCol === 'id' && odooField === 'id') {
      const value = row.data['id']
      if (value !== undefined && value !== '') {
        result['__external_id__'] = value
      }
      continue
    }
    if (csvCol === '.id' && odooField === '.id') {
      const value = row.data['.id']
      if (value !== undefined && value !== '') {
        result['id'] = parseInt(value, 10)
      }
      continue
    }

    // Handle operation column for Strategy 3: Explicit Operation
    if ((csvCol === 'op' || csvCol === '__op__') && odooField === '__op__') {
      const value = row.data[csvCol]
      if (value !== undefined && value !== '') {
        result['__op__'] = value
      }
      continue
    }

    const value = row.data[csvCol]
    if (value === undefined || value === '') continue

    // Handle reference suffixes in CSV column headers
    // /id suffix: External ID reference - pass as string for backend resolution
    if (csvCol.endsWith('/id')) {
      const targetField = odooField.endsWith('/id') ? odooField.slice(0, -3) : odooField
      result[targetField] = value
      continue
    }

    // /.id suffix: Database ID - convert to integer (validated by backend)
    if (csvCol.endsWith('/.id')) {
      const targetField = odooField.endsWith('/.id') ? odooField.slice(0, -4) : odooField
      result[targetField] = parseInt(value, 10)
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
}

export async function executeBatch(
  model: string,
  rows: ParsedRow[],
  mapping: MappingConfig,
  dryRun?: boolean
): Promise<BatchResult[]> {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')

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
    endpoint: '/csv_import/run',
    params: {
      model,
      rows: transformedRows.map(r => r.data),
      use_external_id: idColumn === 'id',
      search_keys: mapping.searchKeys || null,
      dry_run: dryRun || false,
      strict: mapping.strict || false
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
