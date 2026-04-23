import { describe, it, expect } from 'vitest'
import { formatNumber } from '@/utils/formatters'

describe('formatNumber', () => {
  it('formats numbers with separators', () => {
    expect(formatNumber(1234567)).toMatch(/1.*234.*567/)
    expect(formatNumber(42)).toBe('42')
  })
})
