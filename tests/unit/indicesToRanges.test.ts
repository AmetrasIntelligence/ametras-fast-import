import { describe, it, expect } from 'vitest'
import { indicesToRanges } from '@/importer/engine'

describe('indicesToRanges', () => {
  it('returns empty array for empty set', () => {
    expect(indicesToRanges(new Set())).toEqual([])
  })

  it('returns single range for single element', () => {
    expect(indicesToRanges(new Set([5]))).toEqual([[5, 5]])
  })

  it('merges contiguous indices into one range', () => {
    expect(indicesToRanges(new Set([1, 2, 3, 4, 5]))).toEqual([[1, 5]])
  })

  it('creates separate ranges for non-contiguous indices', () => {
    expect(indicesToRanges(new Set([1, 2, 3, 5, 6, 10]))).toEqual([
      [1, 3],
      [5, 6],
      [10, 10],
    ])
  })

  it('handles unsorted input correctly', () => {
    // Sets don't guarantee order, but the function should sort internally
    const indices = new Set([10, 1, 5, 3, 2, 6])
    expect(indicesToRanges(indices)).toEqual([
      [1, 3],
      [5, 6],
      [10, 10],
    ])
  })

  it('handles all-separate indices (no merging)', () => {
    expect(indicesToRanges(new Set([1, 3, 5, 7]))).toEqual([
      [1, 1],
      [3, 3],
      [5, 5],
      [7, 7],
    ])
  })

  it('handles two adjacent ranges', () => {
    expect(indicesToRanges(new Set([1, 2, 4, 5]))).toEqual([
      [1, 2],
      [4, 5],
    ])
  })

  it('handles large contiguous range', () => {
    const indices = new Set<number>()
    for (let i = 1; i <= 1000; i++) indices.add(i)
    expect(indicesToRanges(indices)).toEqual([[1, 1000]])
  })

  it('handles large set with gaps', () => {
    const indices = new Set<number>()
    // 1-100, 200-300, 500
    for (let i = 1; i <= 100; i++) indices.add(i)
    for (let i = 200; i <= 300; i++) indices.add(i)
    indices.add(500)
    expect(indicesToRanges(indices)).toEqual([
      [1, 100],
      [200, 300],
      [500, 500],
    ])
  })

  it('handles negative indices', () => {
    expect(indicesToRanges(new Set([-3, -2, -1, 0, 1]))).toEqual([[-3, 1]])
  })
})
