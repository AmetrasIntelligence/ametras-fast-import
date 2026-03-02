import { describe, it, expect } from 'vitest'
import { NetworkBatchError } from '@/importer/batchExecutor'
import type { ParsedRow } from '@/importer/csvParser'

describe('NetworkBatchError', () => {
  const mockRows: ParsedRow[] = [
    { index: 1, data: { name: 'Alice' } },
    { index: 2, data: { name: 'Bob' } },
  ]

  it('is an instance of Error', () => {
    const err = new NetworkBatchError('Server unavailable', mockRows)
    expect(err).toBeInstanceOf(Error)
  })

  it('has the name NetworkBatchError', () => {
    const err = new NetworkBatchError('Server unavailable', mockRows)
    expect(err.name).toBe('NetworkBatchError')
  })

  it('stores the error message', () => {
    const err = new NetworkBatchError('HTTP 502 Bad Gateway', mockRows)
    expect(err.message).toBe('HTTP 502 Bad Gateway')
  })

  it('stores the rows that were being processed', () => {
    const err = new NetworkBatchError('timeout', mockRows)
    expect(err.rows).toBe(mockRows)
    expect(err.rows).toHaveLength(2)
    expect(err.rows[0].index).toBe(1)
    expect(err.rows[1].index).toBe(2)
  })

  it('rows property is readonly', () => {
    const err = new NetworkBatchError('timeout', mockRows)
    // TypeScript readonly prevents reassignment at compile time
    // At runtime we can verify it holds the reference
    expect(err.rows).toBe(mockRows)
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
