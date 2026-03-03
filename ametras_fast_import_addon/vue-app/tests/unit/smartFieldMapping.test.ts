import { describe, it, expect } from 'vitest'
import {
  scoreFieldMatch,
  autoMapFields
} from '@/utils/smartFieldMapping'
import type { OdooField } from '@/api/odooClient'

const mockFields: OdooField[] = [
  { name: 'name', type: 'char', string: 'Name', required: true, readonly: false },
  { name: 'email', type: 'char', string: 'Email', required: false, readonly: false },
  { name: 'phone', type: 'char', string: 'Phone', required: false, readonly: false },
  { name: 'street', type: 'char', string: 'Street', required: false, readonly: false },
  { name: 'city', type: 'char', string: 'City', required: false, readonly: false },
  { name: 'zip', type: 'char', string: 'Zip', required: false, readonly: false },
  { name: 'country_id', type: 'many2one', string: 'Country', required: false, readonly: false, relation: 'res.country' },
  { name: 'is_company', type: 'boolean', string: 'Is Company', required: false, readonly: false },
  { name: 'ref', type: 'char', string: 'Reference', required: false, readonly: false },
  { name: 'website', type: 'char', string: 'Website', required: false, readonly: false },
  { name: 'id', type: 'integer', string: 'ID', required: false, readonly: true },
  { name: 'create_date', type: 'datetime', string: 'Created on', required: false, readonly: true },
]

describe('scoreFieldMatch', () => {
  it('scores all match types correctly', () => {
    const field = (name: string) => mockFields.find(f => f.name === name)!

    const exactCases: [string, string, number][] = [
      ['name', 'name', 100],
      ['email', 'email', 100],
      ['Name', 'name', 100],
      ['e_mail', 'email', 100],
      ['e-mail', 'email', 100],
    ]
    for (const [header, fieldName, expected] of exactCases) {
      expect(scoreFieldMatch(header, field(fieldName))).toBe(expected)
    }

    const aliasCases: [string, string][] = [
      ['adresse', 'street'], ['strasse', 'street'],
      ['telefon', 'phone'], ['tel', 'phone'],
      ['plz', 'zip'], ['postcode', 'zip'],
      ['referenz', 'ref'],
    ]
    for (const [header, fieldName] of aliasCases) {
      expect(scoreFieldMatch(header, field(fieldName))).toBe(70)
    }

    expect(scoreFieldMatch('xyzabc', field('name'))).toBe(0)
    expect(scoreFieldMatch('id', field('country_id'))).toBe(0)
    expect(scoreFieldMatch('phone_number', field('phone'))).toBeGreaterThan(0)
  })
})

describe('autoMapFields', () => {
  it('maps exact matching headers', () => {
    const mapping = autoMapFields(['name', 'email', 'phone'], mockFields)
    expect(mapping.name).toBe('name')
    expect(mapping.email).toBe('email')
    expect(mapping.phone).toBe('phone')
  })

  it('skips readonly fields except id and maps German headers', () => {
    const mapping = autoMapFields(['id', 'name', 'create_date'], mockFields)
    expect(mapping.id).toBe('id')
    expect(mapping.name).toBe('name')
    expect(mapping.create_date).toBeUndefined()

    const germanMapping = autoMapFields(['telefon', 'strasse', 'plz'], mockFields)
    expect(germanMapping.telefon).toBe('phone')
    expect(germanMapping.strasse).toBe('street')
    expect(germanMapping.plz).toBe('zip')
  })

  it('does not double-assign fields and respects threshold', () => {
    const mapping = autoMapFields(['name', 'Name', 'NAME'], mockFields)
    const assignedToName = Object.values(mapping).filter(v => v === 'name')
    expect(assignedToName.length).toBeLessThanOrEqual(1)

    const emptyMapping = autoMapFields(['xyzabc', 'random_col'], mockFields, 50)
    expect(Object.keys(emptyMapping)).toHaveLength(0)
  })

  it('handles mixed case and separators', () => {
    const mapping = autoMapFields(['E-Mail', 'Phone_Number'], mockFields)
    expect(mapping['E-Mail']).toBe('email')
  })
})

describe('autoMapFields with id columns', () => {
  it('auto-maps id and .id columns', () => {
    const cases: [string[], Record<string, string>][] = [
      [['id', 'name', 'email'], { id: 'id', name: 'name', email: 'email' }],
      [['.id', 'name', 'email'], { '.id': '.id', name: 'name', email: 'email' }],
      [['id', '.id', 'name'], { id: 'id', '.id': '.id', name: 'name' }],
    ]
    for (const [headers, expected] of cases) {
      const mapping = autoMapFields(headers, mockFields)
      for (const [key, value] of Object.entries(expected)) {
        expect(mapping[key]).toBe(value)
      }
    }
  })
})

describe('autoMapFields with /id and /.id headers', () => {
  const fieldsWithRelations: OdooField[] = [
    { name: 'name', type: 'char', string: 'Name', required: true, readonly: false },
    { name: 'partner_id', type: 'many2one', string: 'Partner', required: false, readonly: false, relation: 'res.partner' },
    { name: 'categ_id', type: 'many2one', string: 'Category', required: false, readonly: false, relation: 'product.category' },
    { name: 'tag_ids', type: 'many2many', string: 'Tags', required: false, readonly: false, relation: 'res.partner.category' },
    { name: 'email', type: 'char', string: 'Email', required: false, readonly: false },
  ]

  it('maps relational /id and /.id headers', () => {
    const cases: [string[], Record<string, string>][] = [
      [['name', 'partner_id/id', 'email'], { 'partner_id/id': 'partner_id/id', name: 'name', email: 'email' }],
      [['name', 'partner_id/.id'], { 'partner_id/.id': 'partner_id/.id' }],
      [['tag_ids/id'], { 'tag_ids/id': 'tag_ids/id' }],
      [['partner_id/id', 'categ_id/id', 'name'], { 'partner_id/id': 'partner_id/id', 'categ_id/id': 'categ_id/id', name: 'name' }],
    ]
    for (const [headers, expected] of cases) {
      const mapping = autoMapFields(headers, fieldsWithRelations)
      for (const [key, value] of Object.entries(expected)) {
        expect(mapping[key]).toBe(value)
      }
    }
  })

  it('does not map /id for non-relational fields and avoids double-assign', () => {
    expect(autoMapFields(['email/id'], fieldsWithRelations)['email/id']).toBeUndefined()

    const mapping = autoMapFields(['partner_id/id', 'partner_id'], fieldsWithRelations)
    expect(mapping['partner_id/id']).toBe('partner_id/id')
    expect(mapping['partner_id']).toBeUndefined()
  })
})

// Note: getFieldSuggestions, detectTransform, autoMapFieldsRich,
// detectTransformFromMapping, getBaseFieldName, and transformValue
// were removed from smartFieldMapping.ts as unused exports
