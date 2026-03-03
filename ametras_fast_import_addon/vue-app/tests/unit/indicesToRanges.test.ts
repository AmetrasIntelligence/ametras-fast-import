import { describe, it, expect } from 'vitest'
import { indicesToRanges } from '@/importer/engine'

describe('indicesToRanges', () => {
  it('converts all index patterns to ranges', () => {
    const cases: [Set<number>, number[][]][] = [
      [new Set(), []],
      [new Set([5]), [[5, 5]]],
      [new Set([1, 2, 3, 4, 5]), [[1, 5]]],
      [new Set([1, 2, 3, 5, 6, 10]), [[1, 3], [5, 6], [10, 10]]],
      [new Set([10, 1, 5, 3, 2, 6]), [[1, 3], [5, 6], [10, 10]]],
      [new Set([1, 3, 5, 7]), [[1, 1], [3, 3], [5, 5], [7, 7]]],
      [new Set([1, 2, 4, 5]), [[1, 2], [4, 5]]],
      [new Set([-3, -2, -1, 0, 1]), [[-3, 1]]],
    ]
    for (const [input, expected] of cases) {
      expect(indicesToRanges(input)).toEqual(expected)
    }
  })

  it('handles large sets', () => {
    const contiguous = new Set<number>()
    for (let i = 1; i <= 1000; i++) contiguous.add(i)
    expect(indicesToRanges(contiguous)).toEqual([[1, 1000]])

    const withGaps = new Set<number>()
    for (let i = 1; i <= 100; i++) withGaps.add(i)
    for (let i = 200; i <= 300; i++) withGaps.add(i)
    withGaps.add(500)
    expect(indicesToRanges(withGaps)).toEqual([[1, 100], [200, 300], [500, 500]])
  })
})
