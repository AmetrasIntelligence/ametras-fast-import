import { describe, it, expect } from 'vitest'
import {
  partitionImportFiles,
  isSuspiciousZeroImport,
  finalizeImportOutcome,
} from '@/utils/runOutcome'
import { ImportState } from '@/types/importState'

describe('partitionImportFiles', () => {
  const files = [
    { id: 'id-a', name: 'a.csv' },
    { id: 'id-b', name: 'b.csv' },
  ]

  it('marks files runnable only when present AND mapped', () => {
    const { runnable, skipped } = partitionImportFiles(
      ['a.csv', 'b.csv'],
      files,
      { 'a.csv': { model: 'res.partner' }, 'b.csv': { model: 'product.template' } }
    )
    expect(runnable).toEqual([
      { filename: 'a.csv', fileId: 'id-a' },
      { filename: 'b.csv', fileId: 'id-b' },
    ])
    expect(skipped).toEqual([])
  })

  it('skips a sequence entry with no matching file (file-missing)', () => {
    const { runnable, skipped } = partitionImportFiles(
      ['a.csv', 'ghost.csv'],
      files,
      { 'a.csv': {}, 'ghost.csv': {} }
    )
    expect(runnable.map(r => r.filename)).toEqual(['a.csv'])
    expect(skipped).toEqual([{ filename: 'ghost.csv', reason: 'file-missing' }])
  })

  it('skips a present file with no mapping (no-mapping)', () => {
    const { runnable, skipped } = partitionImportFiles(
      ['a.csv', 'b.csv'],
      files,
      { 'a.csv': {} } // b.csv has no mapping entry
    )
    expect(runnable.map(r => r.filename)).toEqual(['a.csv'])
    expect(skipped).toEqual([{ filename: 'b.csv', reason: 'no-mapping' }])
  })

  it('skips ALL files when none line up (the reported bug scenario)', () => {
    const { runnable, skipped } = partitionImportFiles(
      ['x.csv', 'y.csv'],
      files,
      { 'x.csv': {}, 'y.csv': {} } // names exist in mappings but not in files
    )
    expect(runnable).toEqual([])
    expect(skipped).toEqual([
      { filename: 'x.csv', reason: 'file-missing' },
      { filename: 'y.csv', reason: 'file-missing' },
    ])
  })
})

describe('isSuspiciousZeroImport', () => {
  it('flags 0 imported + 0 failed when rows were expected', () => {
    expect(isSuspiciousZeroImport(0, 0, 120)).toBe(true)
  })
  it('does not flag a genuinely empty file (0 expected)', () => {
    expect(isSuspiciousZeroImport(0, 0, 0)).toBe(false)
  })
  it('does not flag when rows were imported or failed', () => {
    expect(isSuspiciousZeroImport(5, 0, 120)).toBe(false)
    expect(isSuspiciousZeroImport(0, 5, 120)).toBe(false)
  })
})

describe('finalizeImportOutcome', () => {
  it('is COMPLETED when files ran without failures', () => {
    const o = finalizeImportOutcome({ processedCount: 2, skippedCount: 0, totalFailed: 0, errorCount: 0, cancelled: false })
    expect(o).toEqual({ state: ImportState.COMPLETED, nothingRan: false })
  })

  it('FAILS (nothingRan) when every file was skipped — no silent 0/0', () => {
    const o = finalizeImportOutcome({ processedCount: 0, skippedCount: 3, totalFailed: 0, errorCount: 0, cancelled: false })
    expect(o.state).toBe(ImportState.FAILED)
    expect(o.nothingRan).toBe(true)
  })

  it('is COMPLETED when some ran and some were skipped', () => {
    const o = finalizeImportOutcome({ processedCount: 1, skippedCount: 2, totalFailed: 0, errorCount: 0, cancelled: false })
    expect(o).toEqual({ state: ImportState.COMPLETED, nothingRan: false })
  })

  it('FAILS on failures, errors, or cancellation', () => {
    expect(finalizeImportOutcome({ processedCount: 2, skippedCount: 0, totalFailed: 1, errorCount: 0, cancelled: false }).state).toBe(ImportState.FAILED)
    expect(finalizeImportOutcome({ processedCount: 2, skippedCount: 0, totalFailed: 0, errorCount: 3, cancelled: false }).state).toBe(ImportState.FAILED)
    expect(finalizeImportOutcome({ processedCount: 2, skippedCount: 0, totalFailed: 0, errorCount: 0, cancelled: true }).state).toBe(ImportState.FAILED)
  })

  it('does not mark nothingRan when the sequence was simply empty', () => {
    const o = finalizeImportOutcome({ processedCount: 0, skippedCount: 0, totalFailed: 0, errorCount: 0, cancelled: false })
    expect(o.nothingRan).toBe(false)
    expect(o.state).toBe(ImportState.COMPLETED)
  })
})
