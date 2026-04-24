import type { ParsedRow } from './csvParser'

export type TimeoutIdempotencyKeyType = 'id' | '.id' | null

export interface TimeoutRetryIdempotencyAssessment {
  keyType: TimeoutIdempotencyKeyType
  keyColumn: string | null
  safeRows: ParsedRow[]
  unsafeRows: ParsedRow[]
  unsafeReasonCounts: Record<string, number>
}

function findMappedCsvColumn(
  fieldMappings: Record<string, string>,
  targetField: 'id' | '.id'
): string | null {
  for (const [csvCol, odooField] of Object.entries(fieldMappings)) {
    if (odooField === targetField) return csvCol
  }
  return null
}

function countReason(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1
}

/**
 * Row-level timeout idempotency assessment for standalone mode.
 *
 * Mapping-level checks are not sufficient: retries are safe only when each row
 * actually carries a usable key value (id or .id).
 */
export function assessTimeoutRetryIdempotency(
  rows: ParsedRow[],
  fieldMappings: Record<string, string>
): TimeoutRetryIdempotencyAssessment {
  const externalIdColumn = findMappedCsvColumn(fieldMappings, 'id')
  const dbIdColumn = externalIdColumn ? null : findMappedCsvColumn(fieldMappings, '.id')

  const keyType: TimeoutIdempotencyKeyType =
    externalIdColumn ? 'id' : dbIdColumn ? '.id' : null
  const keyColumn = externalIdColumn || dbIdColumn

  const safeRows: ParsedRow[] = []
  const unsafeRows: ParsedRow[] = []
  const unsafeReasonCounts: Record<string, number> = {}

  if (!keyType || !keyColumn) {
    for (const row of rows) {
      unsafeRows.push(row)
      countReason(unsafeReasonCounts, 'missing_key_mapping')
    }
    return {
      keyType,
      keyColumn: null,
      safeRows,
      unsafeRows,
      unsafeReasonCounts,
    }
  }

  for (const row of rows) {
    const raw = row.data[keyColumn]
    const value = typeof raw === 'string' ? raw.trim() : ''

    if (keyType === 'id') {
      if (value.length > 0) {
        safeRows.push(row)
      } else {
        unsafeRows.push(row)
        countReason(unsafeReasonCounts, 'empty_external_id')
      }
      continue
    }

    if (value.length === 0) {
      unsafeRows.push(row)
      countReason(unsafeReasonCounts, 'empty_database_id')
      continue
    }

    if (/^\d+$/.test(value) && Number(value) > 0) {
      safeRows.push(row)
    } else {
      unsafeRows.push(row)
      countReason(unsafeReasonCounts, 'invalid_database_id')
    }
  }

  return {
    keyType,
    keyColumn,
    safeRows,
    unsafeRows,
    unsafeReasonCounts,
  }
}
