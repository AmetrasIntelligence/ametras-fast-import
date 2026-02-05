import { describe, it, expect } from 'vitest'
import {
  validateFieldMappings,
  getFileMappingStatus
} from '@/importer/fieldMappingValidator'
import type { FieldMapping } from '@/types/fieldMapping'
import type { OdooField } from '@/api/odooClient'

const mockFields: OdooField[] = [
  { name: 'name', type: 'char', string: 'Name', required: true, readonly: false },
  { name: 'email', type: 'char', string: 'Email', required: false, readonly: false },
  { name: 'phone', type: 'char', string: 'Phone', required: false, readonly: false },
  { name: 'partner_id', type: 'many2one', string: 'Partner', required: false, readonly: false, relation: 'res.partner' },
]

function makeMappings(overrides: Partial<FieldMapping>[]): FieldMapping[] {
  return overrides.map(o => ({
    filename: 'test.csv',
    csvHeader: 'col',
    odooField: 'name',
    required: false,
    transform: { type: 'passthrough' },
    ...o
  }))
}

describe('validateFieldMappings', () => {
  it('returns no errors for valid mappings', () => {
    const mappings = makeMappings([
      { csvHeader: 'name', odooField: 'name', required: true },
      { csvHeader: 'email', odooField: 'email' },
    ])

    const errors = validateFieldMappings(
      mappings,
      new Map([['test.csv', ['name', 'email']]]),
      new Map([['res.partner', mockFields]]),
      new Map([['test.csv', 'res.partner']])
    )

    expect(errors).toHaveLength(0)
  })

  it('detects missing required CSV header', () => {
    const mappings = makeMappings([
      { csvHeader: 'name', odooField: 'name', required: true },
      { csvHeader: 'missing_col', odooField: 'email', required: true },
    ])

    const errors = validateFieldMappings(
      mappings,
      new Map([['test.csv', ['name']]]),
      new Map([['res.partner', mockFields]]),
      new Map([['test.csv', 'res.partner']])
    )

    expect(errors).toHaveLength(1)
    expect(errors[0].type).toBe('missing_required')
    expect(errors[0].csvHeader).toBe('missing_col')
  })

  it('detects unknown Odoo field', () => {
    const mappings = makeMappings([
      { csvHeader: 'name', odooField: 'nonexistent_field' },
    ])

    const errors = validateFieldMappings(
      mappings,
      new Map([['test.csv', ['name']]]),
      new Map([['res.partner', mockFields]]),
      new Map([['test.csv', 'res.partner']])
    )

    expect(errors).toHaveLength(1)
    expect(errors[0].type).toBe('unknown_field')
    expect(errors[0].odooField).toBe('nonexistent_field')
  })

  it('detects duplicate target fields', () => {
    const mappings = makeMappings([
      { csvHeader: 'col1', odooField: 'name' },
      { csvHeader: 'col2', odooField: 'name' },
    ])

    const errors = validateFieldMappings(
      mappings,
      new Map([['test.csv', ['col1', 'col2']]]),
      new Map([['res.partner', mockFields]]),
      new Map([['test.csv', 'res.partner']])
    )

    expect(errors).toHaveLength(1)
    expect(errors[0].type).toBe('duplicate_target')
  })

  it('handles multiple files independently', () => {
    const mappings: FieldMapping[] = [
      { filename: 'a.csv', csvHeader: 'name', odooField: 'name', required: true, transform: { type: 'passthrough' } },
      { filename: 'b.csv', csvHeader: 'name', odooField: 'name', required: true, transform: { type: 'passthrough' } },
    ]

    const errors = validateFieldMappings(
      mappings,
      new Map([['a.csv', ['name']], ['b.csv', ['name']]]),
      new Map([['res.partner', mockFields]]),
      new Map([['a.csv', 'res.partner'], ['b.csv', 'res.partner']])
    )

    expect(errors).toHaveLength(0)
  })

  it('does not report required error for non-required fields', () => {
    const mappings = makeMappings([
      { csvHeader: 'missing', odooField: 'name', required: false },
    ])

    const errors = validateFieldMappings(
      mappings,
      new Map([['test.csv', []]]),
      new Map([['res.partner', mockFields]]),
      new Map([['test.csv', 'res.partner']])
    )

    // Should only have unknown_field error (if 'name' exists), not missing_required
    const missingErrors = errors.filter(e => e.type === 'missing_required')
    expect(missingErrors).toHaveLength(0)
  })
})

describe('getFileMappingStatus', () => {
  it('returns none when no mappings exist', () => {
    expect(getFileMappingStatus('test.csv', [], ['name', 'email'])).toBe('none')
  })

  it('returns valid when all headers are mapped', () => {
    const mappings = makeMappings([
      { csvHeader: 'name', odooField: 'name' },
      { csvHeader: 'email', odooField: 'email' },
    ])
    expect(getFileMappingStatus('test.csv', mappings, ['name', 'email'])).toBe('valid')
  })

  it('returns partial when some headers are unmapped', () => {
    const mappings = makeMappings([
      { csvHeader: 'name', odooField: 'name' },
    ])
    expect(getFileMappingStatus('test.csv', mappings, ['name', 'email'])).toBe('partial')
  })

  it('returns none when required header is missing from CSV', () => {
    const mappings = makeMappings([
      { csvHeader: 'missing', odooField: 'name', required: true },
    ])
    expect(getFileMappingStatus('test.csv', mappings, ['name'])).toBe('none')
  })

  it('ignores mappings for other files', () => {
    const mappings: FieldMapping[] = [
      { filename: 'other.csv', csvHeader: 'name', odooField: 'name', required: false, transform: { type: 'passthrough' } },
    ]
    expect(getFileMappingStatus('test.csv', mappings, ['name'])).toBe('none')
  })
})
