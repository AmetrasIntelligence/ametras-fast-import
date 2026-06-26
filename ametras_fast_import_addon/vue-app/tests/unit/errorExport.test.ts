import { describe, expect, it } from 'vitest'
import { buildFailedRowsCsv } from '@/utils/errorExport'

describe('errorExport utilities', () => {
  it('buildFailedRowsCsv creates CSV content with error column', () => {
    const csv = buildFailedRowsCsv(
      ['id', 'name'],
      [
        { rowNumber: 2, data: { id: '2', name: 'B' }, error: 'Missing email' },
        { rowNumber: 1, data: { id: '1', name: 'A, Co' }, error: 'Invalid "name"' },
      ],
    )

    const lines = csv.split('\n')
    expect(lines[0]).toBe('id,name,__import_error__')
    // Sorted by row number: row 1 first
    expect(lines[1]).toBe('1,"A, Co","Invalid ""name"""')
    expect(lines[2]).toBe('2,B,Missing email')
  })
})
