import { describe, it, expect, beforeEach } from 'vitest'
import { RetryQueue } from '@/importer/retryQueue'
import type { ParsedRow } from '@/importer/csvParser'
import type { BatchResult } from '@/importer/batchExecutor'

describe('RetryQueue', () => {
  let queue: RetryQueue

  const mockRows: ParsedRow[] = [
    { index: 1, data: { id: 'p1', name: 'Partner 1' }, raw: ['p1', 'Partner 1'] },
    { index: 2, data: { id: 'p2', name: 'Partner 2' }, raw: ['p2', 'Partner 2'] },
    { index: 3, data: { id: 'p3', name: 'Partner 3' }, raw: ['p3', 'Partner 3'] }
  ]

  beforeEach(() => {
    queue = new RetryQueue(3)
  })

  describe('addFailedRows', () => {
    it('adds failed rows to queue', () => {
      const results: BatchResult[] = [
        { ok: true, rowIndex: 1 },
        { ok: false, rowIndex: 2, error: 'Validation error' },
        { ok: true, rowIndex: 3 }
      ]

      queue.addFailedRows(mockRows, results)

      expect(queue.pendingCount).toBe(1)
      expect(queue.failedCount).toBe(0)
    })

    it('does not add successful rows', () => {
      const results: BatchResult[] = [
        { ok: true, rowIndex: 1 },
        { ok: true, rowIndex: 2 },
        { ok: true, rowIndex: 3 }
      ]

      queue.addFailedRows(mockRows, results)

      expect(queue.pendingCount).toBe(0)
    })

    it('tracks attempt count across multiple failures', () => {
      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Error 1' }
      ]

      queue.addFailedRows([mockRows[0]], results)
      expect(queue.getRetryableRows()[0].state.attempts).toBe(1)

      queue.addFailedRows([mockRows[0]], results)
      expect(queue.getRetryableRows()[0].state.attempts).toBe(2)

      queue.addFailedRows([mockRows[0]], results)
      expect(queue.getRetryableRows()).toHaveLength(0)
      expect(queue.getFailedRows()).toHaveLength(1)
      expect(queue.getFailedRows()[0].state.attempts).toBe(3)
    })

    it('stores last error message', () => {
      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'First error' }
      ]

      queue.addFailedRows([mockRows[0]], results)
      expect(queue.getRetryableRows()[0].state.lastError).toBe('First error')

      const results2: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Second error' }
      ]

      queue.addFailedRows([mockRows[0]], results2)
      expect(queue.getRetryableRows()[0].state.lastError).toBe('Second error')
    })
  })

  describe('getRetryableRows', () => {
    it('returns rows with attempts < maxRetries', () => {
      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Error' },
        { ok: false, rowIndex: 2, error: 'Error' }
      ]

      queue.addFailedRows(mockRows.slice(0, 2), results)

      const retryable = queue.getRetryableRows()
      expect(retryable).toHaveLength(2)
      expect(retryable[0].state.attempts).toBe(1)
    })

    it('excludes rows that exceeded maxRetries', () => {
      queue = new RetryQueue(1) // Only 1 retry allowed

      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Error' }
      ]

      queue.addFailedRows([mockRows[0]], results)
      expect(queue.getRetryableRows()).toHaveLength(0)
      expect(queue.getFailedRows()).toHaveLength(1)
    })
  })

  describe('getFailedRows', () => {
    it('returns rows that exceeded maxRetries', () => {
      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Error' }
      ]

      // Fail 3 times (maxRetries = 3)
      queue.addFailedRows([mockRows[0]], results)
      queue.addFailedRows([mockRows[0]], results)
      queue.addFailedRows([mockRows[0]], results)

      expect(queue.getFailedRows()).toHaveLength(1)
      expect(queue.getFailedRows()[0].state.attempts).toBe(3)
    })
  })

  describe('markSuccess', () => {
    it('removes row from queue on success', () => {
      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Error' },
        { ok: false, rowIndex: 2, error: 'Error' }
      ]

      queue.addFailedRows(mockRows.slice(0, 2), results)
      expect(queue.pendingCount).toBe(2)

      queue.markSuccess(1)
      expect(queue.pendingCount).toBe(1)

      const remaining = queue.getRetryableRows()
      expect(remaining[0].row.index).toBe(2)
    })
  })

  describe('clear', () => {
    it('removes all rows from queue', () => {
      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Error' },
        { ok: false, rowIndex: 2, error: 'Error' }
      ]

      queue.addFailedRows(mockRows.slice(0, 2), results)
      expect(queue.pendingCount).toBe(2)

      queue.clear()
      expect(queue.pendingCount).toBe(0)
      expect(queue.failedCount).toBe(0)
    })
  })

  describe('exportFailedCSV', () => {
    it('exports failed rows as CSV', () => {
      queue = new RetryQueue(1) // Make rows fail immediately

      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Error' },
        { ok: false, rowIndex: 2, error: 'Error' }
      ]

      queue.addFailedRows(mockRows.slice(0, 2), results)

      const csv = queue.exportFailedCSV(['id', 'name'])
      const lines = csv.split('\n')

      expect(lines[0]).toBe('id,name')
      expect(lines[1]).toBe('p1,Partner 1')
      expect(lines[2]).toBe('p2,Partner 2')
    })

    it('handles special characters in CSV export', () => {
      queue = new RetryQueue(1)

      const specialRow: ParsedRow = {
        index: 1,
        data: { id: 'p1', name: 'Test, "Company"' },
        raw: ['p1', 'Test, "Company"']
      }

      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Error' }
      ]

      queue.addFailedRows([specialRow], results)

      const csv = queue.exportFailedCSV(['id', 'name'])
      expect(csv).toContain('"Test, ""Company"""')
    })

    it('returns empty string when no failed rows', () => {
      const csv = queue.exportFailedCSV(['id', 'name'])
      expect(csv).toBe('')
    })
  })

  describe('counts', () => {
    it('pendingCount reflects retryable rows', () => {
      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Error' },
        { ok: false, rowIndex: 2, error: 'Error' }
      ]

      queue.addFailedRows(mockRows.slice(0, 2), results)
      expect(queue.pendingCount).toBe(2)
    })

    it('failedCount reflects permanently failed rows', () => {
      queue = new RetryQueue(1)

      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Error' }
      ]

      queue.addFailedRows([mockRows[0]], results)
      expect(queue.pendingCount).toBe(0)
      expect(queue.failedCount).toBe(1)
    })
  })
})
