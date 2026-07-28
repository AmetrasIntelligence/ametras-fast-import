import { describe, expect, it } from 'vitest'
import { failedRowNumbers, aggregateValidation } from '@/utils/validationAggregate'
import type { ValidationFileReport } from '@/api/odooClient'

function report(over: Partial<ValidationFileReport> = {}): ValidationFileReport {
  return {
    model: 'res.partner',
    checked: 0,
    ok: 0,
    failedRows: 0,
    mismatches: [],
    unvalidatable: [],
    ...over,
  }
}

describe('failedRowNumbers', () => {
  const errors = [
    { filename: 'a.csv', rowNumber: 2 },
    { filename: 'a.csv', rowNumber: 5 },
    { filename: 'b.csv', rowNumber: 3 },
    { filename: 'a.csv', rowNumber: 0 }, // file-level error → excluded
  ]

  it('returns only data-row numbers for the given file', () => {
    expect(failedRowNumbers(errors, 'a.csv')).toEqual([2, 5])
    expect(failedRowNumbers(errors, 'b.csv')).toEqual([3])
  })

  it('returns [] when the file has no errors', () => {
    expect(failedRowNumbers(errors, 'c.csv')).toEqual([])
  })
})

describe('aggregateValidation', () => {
  it('sums totals and counts unvalidatable entries across files', () => {
    const agg = aggregateValidation([
      {
        filename: 'a.csv',
        report: report({ checked: 10, ok: 9, failedRows: 1, unvalidatable: [{ rowNumber: 4, reason: 'x' }] }),
      },
      {
        filename: 'b.csv',
        report: report({ checked: 5, ok: 5, failedRows: 0 }),
      },
    ])

    expect(agg.checked).toBe(15)
    expect(agg.ok).toBe(14)
    expect(agg.failedRows).toBe(1)
    expect(agg.unvalidatable).toBe(1)
    expect(Object.keys(agg.perFile)).toEqual(['a.csv', 'b.csv'])
  })

  it('is empty for no reports', () => {
    const agg = aggregateValidation([])
    expect(agg).toEqual({ checked: 0, ok: 0, failedRows: 0, unvalidatable: 0, perFile: {} })
  })
})
