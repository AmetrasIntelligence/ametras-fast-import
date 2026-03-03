import { describe, it, expect } from 'vitest'
import {
  formatField,
  formatNumber,
  formatBytes,
  formatDuration,
  truncate,
  formatErrorMessage
} from '@/utils/formatters'
import type { OdooField } from '@/api/odooClient'

describe('formatField', () => {
  it('formats fields with all attribute combinations', () => {
    const cases: [OdooField, string][] = [
      [{ name: 'name', type: 'char', string: 'Name' }, 'name (char)'],
      [{ name: 'name', type: 'char', string: 'Name', required: true }, 'name (char, required)'],
      [{ name: 'id', type: 'integer', string: 'ID', readonly: true }, 'id (integer, readonly)'],
      [{ name: 'name', type: 'char', string: 'Name', required: true, readonly: true }, 'name (char, required, readonly)'],
    ]
    for (const [field, expected] of cases) {
      expect(formatField(field)).toBe(expected)
    }
  })
})

describe('formatNumber', () => {
  it('formats numbers with separators', () => {
    expect(formatNumber(1234567)).toMatch(/1.*234.*567/)
    expect(formatNumber(42)).toBe('42')
  })
})

describe('formatBytes', () => {
  it('formats all size units', () => {
    const cases: [number, string][] = [
      [0, '0 B'],
      [500, '500 B'],
      [1024, '1 KB'],
      [1024 * 1024, '1 MB'],
      [1024 * 1024 * 1024, '1 GB'],
    ]
    for (const [input, expected] of cases) {
      expect(formatBytes(input)).toBe(expected)
    }
  })
})

describe('formatDuration', () => {
  it('formats all duration ranges', () => {
    const cases: [number, string][] = [
      [500, '500ms'],
      [5000, '5.0s'],
      [125000, '2m 5s'],
    ]
    for (const [input, expected] of cases) {
      expect(formatDuration(input)).toBe(expected)
    }
  })
})

describe('truncate', () => {
  it('truncates correctly', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('hello world', 8)).toBe('hello...')
    expect(truncate('hello', 5)).toBe('hello')
  })
})

describe('formatErrorMessage', () => {
  it('extracts messages from all input types', () => {
    const cases: [unknown, string][] = [
      ['Error occurred', 'Error occurred'],
      [new Error('Something failed'), 'Something failed'],
      [{ message: 'Object error' }, 'Object error'],
      [{ error: 'Error string' }, 'Error string'],
    ]
    for (const [input, expected] of cases) {
      expect(formatErrorMessage(input)).toBe(expected)
    }

    expect(formatErrorMessage(null)).toBe('Unknown error')
    expect(formatErrorMessage(undefined)).toBe('Unknown error')
  })
})
