import { describe, it, expect } from 'vitest'
import { NetworkBatchError } from '@/importer/batchExecutor'
import type { ParsedRow } from '@/importer/csvParser'

describe('NetworkBatchError', () => {
  const mockRows: ParsedRow[] = [
    { index: 1, data: { name: 'Alice' } },
    { index: 2, data: { name: 'Bob' } },
  ]

  it('is an Error with correct name, message, and rows', () => {
    const err = new NetworkBatchError('HTTP 502 Bad Gateway', mockRows)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('NetworkBatchError')
    expect(err.message).toBe('HTTP 502 Bad Gateway')
    expect(err.rows).toBe(mockRows)
    expect(err.rows).toHaveLength(2)
    expect(err.rows[0].index).toBe(1)
    expect(err.rows[1].index).toBe(2)
  })

  it('can be caught as Error in try/catch', () => {
    try {
      throw new NetworkBatchError('test', mockRows)
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
      expect(e).toBeInstanceOf(NetworkBatchError)
      expect((e as NetworkBatchError).rows).toBe(mockRows)
    }
  })

  it('works with empty rows array', () => {
    const err = new NetworkBatchError('error', [])
    expect(err.rows).toEqual([])
    expect(err.rows).toHaveLength(0)
  })
})
