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
  it('gives 100 for exact field name match', () => {
    expect(scoreFieldMatch('name', mockFields[0])).toBe(100)
    expect(scoreFieldMatch('email', mockFields[1])).toBe(100)
  })

  it('gives 95 for exact field label match', () => {
    expect(scoreFieldMatch('Name', mockFields[0])).toBe(100)  // lowercase match still exact
  })

  it('matches German aliases', () => {
    const streetField = mockFields.find(f => f.name === 'street')!
    expect(scoreFieldMatch('adresse', streetField)).toBe(70)
    expect(scoreFieldMatch('strasse', streetField)).toBe(70)
  })

  it('matches phone aliases', () => {
    const phoneField = mockFields.find(f => f.name === 'phone')!
    expect(scoreFieldMatch('telefon', phoneField)).toBe(70)
    expect(scoreFieldMatch('tel', phoneField)).toBe(70)
  })

  it('matches zip aliases', () => {
    const zipField = mockFields.find(f => f.name === 'zip')!
    expect(scoreFieldMatch('plz', zipField)).toBe(70)
    expect(scoreFieldMatch('postcode', zipField)).toBe(70)
  })

  it('matches reference aliases', () => {
    const refField = mockFields.find(f => f.name === 'ref')!
    expect(scoreFieldMatch('referenz', refField)).toBe(70)
  })

  it('gives partial match for contains (3+ chars)', () => {
    const score = scoreFieldMatch('phone_number', mockFields[2])
    expect(score).toBeGreaterThan(0)
  })

  it('does not match short headers via contains', () => {
    // 'id' (2 chars) should not match 'country_id' via substring
    const countryField = mockFields.find(f => f.name === 'country_id')!
    expect(scoreFieldMatch('id', countryField)).toBe(0)
  })

  it('returns 0 for completely unrelated headers', () => {
    expect(scoreFieldMatch('xyzabc', mockFields[0])).toBe(0)
  })

  it('handles hyphens and underscores', () => {
    expect(scoreFieldMatch('e_mail', mockFields[1])).toBe(100)
    expect(scoreFieldMatch('e-mail', mockFields[1])).toBe(100)
  })
})

describe('autoMapFields', () => {
  it('maps exact matching headers', () => {
    const headers = ['name', 'email', 'phone']
    const mapping = autoMapFields(headers, mockFields)

    expect(mapping.name).toBe('name')
    expect(mapping.email).toBe('email')
    expect(mapping.phone).toBe('phone')
  })

  it('skips readonly fields except id and .id', () => {
    const headers = ['id', 'name', 'create_date']
    const mapping = autoMapFields(headers, mockFields)

    // id column is special (upsert key) - auto-mapped
    expect(mapping.id).toBe('id')
    expect(mapping.name).toBe('name')
    // Other readonly fields are still skipped
    expect(mapping.create_date).toBeUndefined()
  })

  it('does not double-assign fields', () => {
    const headers = ['name', 'Name', 'NAME']
    const mapping = autoMapFields(headers, mockFields)

    const assignedToName = Object.values(mapping).filter(v => v === 'name')
    expect(assignedToName.length).toBeLessThanOrEqual(1)
  })

  it('respects minimum score threshold', () => {
    const headers = ['xyzabc', 'random_col']
    const mapping = autoMapFields(headers, mockFields, 50)

    expect(Object.keys(mapping)).toHaveLength(0)
  })

  it('maps German headers to correct fields', () => {
    const headers = ['telefon', 'strasse', 'plz']
    const mapping = autoMapFields(headers, mockFields)

    expect(mapping.telefon).toBe('phone')
    expect(mapping.strasse).toBe('street')
    expect(mapping.plz).toBe('zip')
  })

  it('handles mixed case and separators', () => {
    const headers = ['E-Mail', 'Phone_Number']
    const mapping = autoMapFields(headers, mockFields)

    expect(mapping['E-Mail']).toBe('email')
  })
})

describe('autoMapFields with id and .id columns', () => {
  it('auto-maps id column to id for upsert', () => {
    const headers = ['id', 'name', 'email']
    const mapping = autoMapFields(headers, mockFields)

    expect(mapping['id']).toBe('id')
    expect(mapping['name']).toBe('name')
    expect(mapping['email']).toBe('email')
  })

  it('auto-maps .id column to .id for upsert', () => {
    const headers = ['.id', 'name', 'email']
    const mapping = autoMapFields(headers, mockFields)

    expect(mapping['.id']).toBe('.id')
    expect(mapping['name']).toBe('name')
    expect(mapping['email']).toBe('email')
  })

  it('auto-maps both id and .id if present', () => {
    const headers = ['id', '.id', 'name']
    const mapping = autoMapFields(headers, mockFields)

    expect(mapping['id']).toBe('id')
    expect(mapping['.id']).toBe('.id')
    expect(mapping['name']).toBe('name')
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

  it('maps partner_id/id header to partner_id/id', () => {
    const headers = ['name', 'partner_id/id', 'email']
    const mapping = autoMapFields(headers, fieldsWithRelations)

    expect(mapping['partner_id/id']).toBe('partner_id/id')
    expect(mapping['name']).toBe('name')
    expect(mapping['email']).toBe('email')
  })

  it('maps partner_id/.id header to partner_id/.id', () => {
    const headers = ['name', 'partner_id/.id']
    const mapping = autoMapFields(headers, fieldsWithRelations)

    expect(mapping['partner_id/.id']).toBe('partner_id/.id')
  })

  it('maps many2many field with /id suffix', () => {
    const headers = ['tag_ids/id']
    const mapping = autoMapFields(headers, fieldsWithRelations)

    expect(mapping['tag_ids/id']).toBe('tag_ids/id')
  })

  it('does not map /id suffix for non-relational fields', () => {
    const headers = ['email/id']
    const mapping = autoMapFields(headers, fieldsWithRelations)

    expect(mapping['email/id']).toBeUndefined()
  })

  it('does not double-assign relational field via /id and base name', () => {
    const headers = ['partner_id/id', 'partner_id']
    const mapping = autoMapFields(headers, fieldsWithRelations)

    // /id variant wins (pre-pass), base name should not also map
    expect(mapping['partner_id/id']).toBe('partner_id/id')
    expect(mapping['partner_id']).toBeUndefined()
  })

  it('handles multiple relational fields with /id', () => {
    const headers = ['partner_id/id', 'categ_id/id', 'name']
    const mapping = autoMapFields(headers, fieldsWithRelations)

    expect(mapping['partner_id/id']).toBe('partner_id/id')
    expect(mapping['categ_id/id']).toBe('categ_id/id')
    expect(mapping['name']).toBe('name')
  })
})

// Note: getFieldSuggestions, detectTransform, autoMapFieldsRich,
// detectTransformFromMapping, getBaseFieldName, and transformValue
// were removed from smartFieldMapping.ts as unused exports
