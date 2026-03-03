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
  it('formats basic field', () => {
    const field: OdooField = { name: 'name', type: 'char', string: 'Name' }
    expect(formatField(field)).toBe('name (char)')
  })

  it('includes required attribute', () => {
    const field: OdooField = { name: 'name', type: 'char', string: 'Name', required: true }
    expect(formatField(field)).toBe('name (char, required)')
  })

  it('includes readonly attribute', () => {
    const field: OdooField = { name: 'id', type: 'integer', string: 'ID', readonly: true }
    expect(formatField(field)).toBe('id (integer, readonly)')
  })

  it('includes multiple attributes', () => {
    const field: OdooField = { name: 'name', type: 'char', string: 'Name', required: true, readonly: true }
    expect(formatField(field)).toBe('name (char, required, readonly)')
  })
})

describe('formatNumber', () => {
  it('formats number with thousands separator', () => {
    expect(formatNumber(1234567)).toMatch(/1.*234.*567/)
  })

  it('handles small numbers', () => {
    expect(formatNumber(42)).toBe('42')
  })
})

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB')
  })

  it('formats megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
  })

  it('formats gigabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB')
  })

  it('handles zero', () => {
    expect(formatBytes(0)).toBe('0 B')
  })
})

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms')
  })

  it('formats seconds', () => {
    expect(formatDuration(5000)).toBe('5.0s')
  })

  it('formats minutes and seconds', () => {
    expect(formatDuration(125000)).toBe('2m 5s')
  })
})

describe('truncate', () => {
  it('does not truncate short strings', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('truncates long strings with ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello...')
  })

  it('handles exact length', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })
})

describe('formatErrorMessage', () => {
  it('returns string errors as-is', () => {
    expect(formatErrorMessage('Error occurred')).toBe('Error occurred')
  })

  it('extracts message from Error object', () => {
    expect(formatErrorMessage(new Error('Something failed'))).toBe('Something failed')
  })

  it('extracts message property from object', () => {
    expect(formatErrorMessage({ message: 'Object error' })).toBe('Object error')
  })

  it('extracts error property from object', () => {
    expect(formatErrorMessage({ error: 'Error string' })).toBe('Error string')
  })

  it('returns default for unknown types', () => {
    expect(formatErrorMessage(null)).toBe('Unknown error')
    expect(formatErrorMessage(undefined)).toBe('Unknown error')
  })
})
