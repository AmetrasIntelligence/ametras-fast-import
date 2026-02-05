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

function transformRow(
  row: ParsedRow,
  mapping: { fieldMappings: Record<string, string>; idColumn: 'id' | '.id' | null }
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [csvCol, odooField] of Object.entries(mapping.fieldMappings)) {
    const value = row.data[csvCol]
    if (value !== undefined && value !== '') {
      result[odooField] = value
    }
  }

  if (mapping.idColumn && row.data[mapping.idColumn]) {
    if (mapping.idColumn === 'id') {
      result['__external_id__'] = row.data['id']
    } else if (mapping.idColumn === '.id') {
      result['id'] = parseInt(row.data['.id'], 10)
    }
  }

  return result
}

export async function executeBatch(
  model: string,
  rows: ParsedRow[],
  mapping: { fieldMappings: Record<string, string>; idColumn: 'id' | '.id' | null },
  dryRun?: boolean
): Promise<BatchResult[]> {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')

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
    }>
  }>({
    baseUrl: session.baseUrl,
    endpoint: '/csv_import/run',
    params: {
      model,
      rows: transformedRows.map(r => r.data),
      use_external_id: mapping.idColumn === 'id',
      dry_run: dryRun || false
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
 * Phase 1: Very limited transforms.
 */
function applyTransform(value: string, transform: FieldTransform): unknown {
  switch (transform.type) {
    case 'passthrough':
      return value
    case 'm2o_ref':
      // Return as external ID reference for Odoo to resolve
      return value
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
