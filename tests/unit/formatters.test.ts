import { describe, it, expect } from 'vitest'
import {
  formatModel,
  formatModelName,
  formatField,
  formatFieldFull,
  formatRelationalField,
  formatNumber,
  formatBytes,
  formatDuration,
  formatRowCount,
  formatFileCount,
  truncate,
  formatErrorMessage,
  formatPercent
} from '@/utils/formatters'
import type { OdooModel, OdooField } from '@/api/odooClient'

describe('formatModel', () => {
  it('formats model with name and technical name', () => {
    const model: OdooModel = { name: 'Product Template', model: 'product.template' }
    expect(formatModel(model)).toBe('Product Template (product.template)')
  })
})

describe('formatModelName', () => {
  it('formats separate name and technical name', () => {
    expect(formatModelName('Customer', 'res.partner')).toBe('Customer (res.partner)')
  })
})

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

describe('formatFieldFull', () => {
  it('shows label and technical name when different', () => {
    const field: OdooField = { name: 'partner_id', type: 'many2one', string: 'Customer' }
    expect(formatFieldFull(field)).toBe('Customer [partner_id] (many2one)')
  })

  it('shows just label when same as name', () => {
    const field: OdooField = { name: 'name', type: 'char', string: 'name' }
    expect(formatFieldFull(field)).toBe('name (char)')
  })
})

describe('formatRelationalField', () => {
  it('formats many2one field with relation', () => {
    const field: OdooField = { name: 'partner_id', type: 'many2one', string: 'Customer', relation: 'res.partner' }
    expect(formatRelationalField(field)).toBe('partner_id → res.partner (many2one)')
  })

  it('falls back to basic format for non-relational field', () => {
    const field: OdooField = { name: 'name', type: 'char', string: 'Name' }
    expect(formatRelationalField(field)).toBe('name (char)')
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

describe('formatRowCount', () => {
  it('formats single row', () => {
    expect(formatRowCount(1)).toBe('1 row')
  })

  it('formats multiple rows', () => {
    expect(formatRowCount(100)).toBe('100 rows')
  })

  it('formats large numbers', () => {
    expect(formatRowCount(10000)).toMatch(/10.*000 rows/)
  })
})

describe('formatFileCount', () => {
  it('formats single file', () => {
    expect(formatFileCount(1)).toBe('1 file')
  })

  it('formats multiple files', () => {
    expect(formatFileCount(5)).toBe('5 files')
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

describe('formatPercent', () => {
  it('formats percentage without decimals', () => {
    expect(formatPercent(0.5)).toBe('50%')
  })

  it('formats percentage with decimals', () => {
    expect(formatPercent(0.123, 1)).toBe('12.3%')
  })

  it('handles zero', () => {
    expect(formatPercent(0)).toBe('0%')
  })

  it('handles 100%', () => {
    expect(formatPercent(1)).toBe('100%')
  })
})
