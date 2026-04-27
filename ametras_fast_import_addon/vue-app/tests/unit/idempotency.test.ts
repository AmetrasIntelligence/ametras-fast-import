import { describe, it, expect } from 'vitest'
import { assessTimeoutRetryIdempotency } from '@/importer/idempotency'
import type { ParsedRow } from '@/importer/csvParser'

function row(index: number, data: Record<string, string>): ParsedRow {
  return { index, data, raw: Object.values(data) }
}

describe('assessTimeoutRetryIdempotency', () => {
  it('marks all rows unsafe when no id/.id mapping exists', () => {
    const rows = [row(1, { name: 'A' }), row(2, { name: 'B' })]
    const result = assessTimeoutRetryIdempotency(rows, { name: 'name' })

    expect(result.keyType).toBeNull()
    expect(result.safeRows).toHaveLength(0)
    expect(result.unsafeRows.map(r => r.index)).toEqual([1, 2])
    expect(result.unsafeReasonCounts).toEqual({ missing_key_mapping: 2 })
  })

  it('checks external ID per row (non-empty only)', () => {
    const rows = [
      row(1, { ext: 'abc' }),
      row(2, { ext: ' ' }),
      row(3, { ext: '' }),
      row(4, { ext: 'xyz' }),
    ]
    const result = assessTimeoutRetryIdempotency(rows, { ext: 'id' })

    expect(result.keyType).toBe('id')
    expect(result.keyColumn).toBe('ext')
    expect(result.safeRows.map(r => r.index)).toEqual([1, 4])
    expect(result.unsafeRows.map(r => r.index)).toEqual([2, 3])
    expect(result.unsafeReasonCounts).toEqual({ empty_external_id: 2 })
  })

  it('checks database ID per row (positive integer only)', () => {
    const rows = [
      row(1, { db: '42' }),
      row(2, { db: '0' }),
      row(3, { db: '-1' }),
      row(4, { db: 'abc' }),
      row(5, { db: '' }),
      row(6, { db: ' 7 ' }),
    ]
    const result = assessTimeoutRetryIdempotency(rows, { db: '.id' })

    expect(result.keyType).toBe('.id')
    expect(result.keyColumn).toBe('db')
    expect(result.safeRows.map(r => r.index)).toEqual([1, 6])
    expect(result.unsafeRows.map(r => r.index)).toEqual([2, 3, 4, 5])
    expect(result.unsafeReasonCounts).toEqual({
      invalid_database_id: 3,
      empty_database_id: 1,
    })
  })

  it('treats id and .id as row-level alternatives when both are mapped', () => {
    const rows = [
      row(1, { ext: 'e1', db: '' }),
      row(2, { ext: '', db: '12' }),
      row(3, { ext: '', db: 'abc' }),
      row(4, { ext: 'e4', db: '0' }),
      row(5, { ext: '', db: '' }),
    ]
    const result = assessTimeoutRetryIdempotency(rows, { ext: 'id', db: '.id' })

    expect(result.keyType).toBe('id')
    expect(result.keyColumn).toBe('ext')
    expect(result.safeRows.map(r => r.index)).toEqual([1, 2, 4])
    expect(result.unsafeRows.map(r => r.index)).toEqual([3, 5])
    expect(result.unsafeReasonCounts).toEqual({
      invalid_database_id: 1,
      empty_external_and_database_id: 1,
    })
  })
})
