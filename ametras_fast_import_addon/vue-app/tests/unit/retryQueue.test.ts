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
    it('adds failed rows and ignores successful ones', () => {
      queue.addFailedRows(mockRows, [
        { ok: true, rowIndex: 1 },
        { ok: false, rowIndex: 2, error: 'Validation error' },
        { ok: true, rowIndex: 3 }
      ])
      expect(queue.pendingCount).toBe(1)
      expect(queue.failedCount).toBe(0)

      const q2 = new RetryQueue(3)
      q2.addFailedRows(mockRows, [
        { ok: true, rowIndex: 1 },
        { ok: true, rowIndex: 2 },
        { ok: true, rowIndex: 3 }
      ])
      expect(q2.pendingCount).toBe(0)
    })

    it('tracks attempts and moves to failed after max retries', () => {
      const results: BatchResult[] = [{ ok: false, rowIndex: 1, error: 'Error 1' }]

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
      queue.addFailedRows([mockRows[0]], [{ ok: false, rowIndex: 1, error: 'First error' }])
      expect(queue.getRetryableRows()[0].state.lastError).toBe('First error')

      queue.addFailedRows([mockRows[0]], [{ ok: false, rowIndex: 1, error: 'Second error' }])
      expect(queue.getRetryableRows()[0].state.lastError).toBe('Second error')
    })
  })

  describe('getRetryableRows / getFailedRows', () => {
    it('separates retryable from permanently failed', () => {
      const results: BatchResult[] = [
        { ok: false, rowIndex: 1, error: 'Error' },
        { ok: false, rowIndex: 2, error: 'Error' }
      ]
      queue.addFailedRows(mockRows.slice(0, 2), results)
      expect(queue.getRetryableRows()).toHaveLength(2)
      expect(queue.getRetryableRows()[0].state.attempts).toBe(1)

      const singleRetry = new RetryQueue(1)
      singleRetry.addFailedRows([mockRows[0]], [{ ok: false, rowIndex: 1, error: 'Error' }])
      expect(singleRetry.getRetryableRows()).toHaveLength(0)
      expect(singleRetry.getFailedRows()).toHaveLength(1)
    })
  })

  describe('markSuccess', () => {
    it('removes row from queue on success', () => {
      queue.addFailedRows(mockRows.slice(0, 2), [
        { ok: false, rowIndex: 1, error: 'Error' },
        { ok: false, rowIndex: 2, error: 'Error' }
      ])
      expect(queue.pendingCount).toBe(2)

      queue.markSuccess(1)
      expect(queue.pendingCount).toBe(1)
      expect(queue.getRetryableRows()[0].row.index).toBe(2)
    })
  })

  describe('clear', () => {
    it('removes all rows from queue', () => {
      queue.addFailedRows(mockRows.slice(0, 2), [
        { ok: false, rowIndex: 1, error: 'Error' },
        { ok: false, rowIndex: 2, error: 'Error' }
      ])
      queue.clear()
      expect(queue.pendingCount).toBe(0)
      expect(queue.failedCount).toBe(0)
    })
  })

  describe('exportFailedCSV', () => {
    it('exports failed rows and handles special characters', () => {
      const q = new RetryQueue(1)
      q.addFailedRows(mockRows.slice(0, 2), [
        { ok: false, rowIndex: 1, error: 'Error' },
        { ok: false, rowIndex: 2, error: 'Error' }
      ])

      const csv = q.exportFailedCSV(['id', 'name'])
      const lines = csv.split('\n')
      expect(lines[0]).toBe('id,name')
      expect(lines[1]).toBe('p1,Partner 1')
      expect(lines[2]).toBe('p2,Partner 2')

      // Special characters
      const q2 = new RetryQueue(1)
      const specialRow: ParsedRow = {
        index: 1,
        data: { id: 'p1', name: 'Test, "Company"' },
        raw: ['p1', 'Test, "Company"']
      }
      q2.addFailedRows([specialRow], [{ ok: false, rowIndex: 1, error: 'Error' }])
      expect(q2.exportFailedCSV(['id', 'name'])).toContain('"Test, ""Company"""')
    })

    it('returns empty string when no failed rows', () => {
      expect(queue.exportFailedCSV(['id', 'name'])).toBe('')
    })
  })

  describe('counts', () => {
    it('reflects pending and failed counts', () => {
      queue.addFailedRows(mockRows.slice(0, 2), [
        { ok: false, rowIndex: 1, error: 'Error' },
        { ok: false, rowIndex: 2, error: 'Error' }
      ])
      expect(queue.pendingCount).toBe(2)

      const q = new RetryQueue(1)
      q.addFailedRows([mockRows[0]], [{ ok: false, rowIndex: 1, error: 'Error' }])
      expect(q.pendingCount).toBe(0)
      expect(q.failedCount).toBe(1)
    })
  })
})
