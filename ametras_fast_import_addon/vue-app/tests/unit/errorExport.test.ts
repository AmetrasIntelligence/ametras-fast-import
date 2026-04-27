import { describe, expect, it } from 'vitest'
import {
  buildFailedRowsCsv,
  buildUnifiedErrorLogCsv,
  groupRowErrorsByFile,
  type ErrorLogExportEntry,
} from '@/utils/errorExport'

describe('errorExport utilities', () => {
  it('buildUnifiedErrorLogCsv exports all errors as one CSV log', () => {
    const errors: ErrorLogExportEntry[] = [
      {
        filename: 'a.csv',
        rowNumber: 1,
        error: 'Invalid "name", missing value',
        timestamp: Date.UTC(2026, 0, 1, 0, 0, 0),
        rawData: { name: 'A, Inc.', id: 'x1' },
      },
      {
        filename: 'b.csv',
        rowNumber: 0,
        error: 'File mapping missing',
        timestamp: Date.UTC(2026, 0, 1, 1, 2, 3),
        rawData: {},
      },
      {
        filename: 'c.csv',
        rowNumber: 7,
        error: 'Missing value',
        timestamp: 0,
      },
    ]

    const csv = buildUnifiedErrorLogCsv(errors)
    const lines = csv.split('\n')

    expect(lines[0]).toBe('filename,row_number,error,timestamp,raw_data_json')
    expect(lines[1]).toContain('a.csv,1,"Invalid ""name"", missing value",2026-01-01T00:00:00.000Z')
    expect(lines[1]).toContain('"{""name"":""A, Inc."",""id"":""x1""}"')
    expect(lines[2]).toBe('b.csv,0,File mapping missing,2026-01-01T01:02:03.000Z,')
    expect(lines[3]).toBe('c.csv,7,Missing value,,')
  })

  it('groupRowErrorsByFile groups row-level errors and ignores file-level rows', () => {
    const grouped = groupRowErrorsByFile([
      { filename: 'a.csv', rowNumber: 0, error: 'file err', timestamp: 1 },
      { filename: 'a.csv', rowNumber: 2, error: 'row err 1', timestamp: 2 },
      { filename: 'a.csv', rowNumber: 2, error: 'row err 2', timestamp: 3 },
      { filename: 'b.csv', rowNumber: 3, error: 'row err b', timestamp: 4 },
    ])

    expect(grouped.size).toBe(2)
    expect(grouped.get('a.csv')?.get(2)).toEqual(['row err 1', 'row err 2'])
    expect(grouped.get('b.csv')?.get(3)).toEqual(['row err b'])
    expect(grouped.get('a.csv')?.get(0)).toBeUndefined()
  })

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
