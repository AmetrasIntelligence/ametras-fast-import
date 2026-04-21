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

function readTrimmedValue(row: ParsedRow, column: string | null): string {
  if (!column) return ''
  const raw = row.data[column]
  return typeof raw === 'string' ? raw.trim() : ''
}

function isValidDatabaseId(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0
}

/**
 * Row-level timeout idempotency assessment for standalone mode.
 *
 * Mapping-level checks are not sufficient: retries are safe only when each row
 * actually carries a usable key value (id or .id). When both are mapped, rows
 * may safely retry with either key:
 * - prefer non-empty external ID ('id')
 * - otherwise fallback to valid database ID ('.id')
 */
export function assessTimeoutRetryIdempotency(
  rows: ParsedRow[],
  fieldMappings: Record<string, string>
): TimeoutRetryIdempotencyAssessment {
  const externalIdColumn = findMappedCsvColumn(fieldMappings, 'id')
  const dbIdColumn = findMappedCsvColumn(fieldMappings, '.id')

  const keyType: TimeoutIdempotencyKeyType =
    externalIdColumn ? 'id' : dbIdColumn ? '.id' : null
  const keyColumn = externalIdColumn || dbIdColumn

  const safeRows: ParsedRow[] = []
  const unsafeRows: ParsedRow[] = []
  const unsafeReasonCounts: Record<string, number> = {}

  if (!externalIdColumn && !dbIdColumn) {
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
    const externalIdValue = readTrimmedValue(row, externalIdColumn)
    const databaseIdValue = readTrimmedValue(row, dbIdColumn)

    if (externalIdValue.length > 0) {
      safeRows.push(row)
      continue
    }

    if (dbIdColumn) {
      if (databaseIdValue.length === 0) {
        unsafeRows.push(row)
        countReason(
          unsafeReasonCounts,
          externalIdColumn ? 'empty_external_and_database_id' : 'empty_database_id'
        )
        continue
      }

      if (isValidDatabaseId(databaseIdValue)) {
        safeRows.push(row)
        continue
      }

      unsafeRows.push(row)
      countReason(unsafeReasonCounts, 'invalid_database_id')
      continue
    }

    unsafeRows.push(row)
    countReason(unsafeReasonCounts, 'empty_external_id')
  }

  return {
    keyType,
    keyColumn,
    safeRows,
    unsafeRows,
    unsafeReasonCounts,
  }
}
