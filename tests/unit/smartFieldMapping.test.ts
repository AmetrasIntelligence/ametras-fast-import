import { describe, it, expect } from 'vitest'
import {
  scoreFieldMatch,
  autoMapFields,
  getFieldSuggestions,
  detectTransform,
  autoMapFieldsRich,
  detectTransformFromMapping,
  getBaseFieldName,
  transformValue
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

describe('getFieldSuggestions', () => {
  it('returns sorted suggestions for a header', () => {
    const suggestions = getFieldSuggestions('name', mockFields)
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions[0].field.name).toBe('name')
    expect(suggestions[0].score).toBe(100)
  })

  it('respects limit parameter', () => {
    const suggestions = getFieldSuggestions('name', mockFields, 2)
    expect(suggestions.length).toBeLessThanOrEqual(2)
  })

  it('filters out readonly fields', () => {
    const suggestions = getFieldSuggestions('id', mockFields)
    const readonlyFields = suggestions.filter(s => s.field.readonly)
    expect(readonlyFields).toHaveLength(0)
  })

  it('returns empty for no matches', () => {
    const suggestions = getFieldSuggestions('zzzzz', mockFields)
    expect(suggestions).toEqual([])
  })
})

describe('detectTransform', () => {
  const m2oField: OdooField = {
    name: 'partner_id',
    type: 'many2one',
    string: 'Partner',
    required: false,
    readonly: false,
    relation: 'res.partner'
  }

  const m2mField: OdooField = {
    name: 'tag_ids',
    type: 'many2many',
    string: 'Tags',
    required: false,
    readonly: false,
    relation: 'res.partner.category'
  }

  const countryField: OdooField = {
    name: 'country_id',
    type: 'many2one',
    string: 'Country',
    required: false,
    readonly: false,
    relation: 'res.country'
  }

  const charField: OdooField = {
    name: 'name',
    type: 'char',
    string: 'Name',
    required: true,
    readonly: false
  }

  it('detects m2o_ref for many2one with /id suffix', () => {
    const transform = detectTransform('partner_id/id', m2oField)
    expect(transform).toEqual({ type: 'm2o_ref', model: 'res.partner' })
  })

  it('detects m2m_ref for many2many with /id suffix', () => {
    const transform = detectTransform('tag_ids/id', m2mField)
    expect(transform).toEqual({ type: 'm2m_ref', model: 'res.partner.category' })
  })

  it('detects db_id for standard model with /.id suffix', () => {
    const transform = detectTransform('country_id/.id', countryField)
    expect(transform).toEqual({ type: 'db_id', model: 'res.country' })
  })

  it('detects db_id for non-standard model with /.id suffix', () => {
    const transform = detectTransform('partner_id/.id', m2oField)
    expect(transform).toEqual({ type: 'db_id', model: 'res.partner' })
  })

  it('returns passthrough for regular header', () => {
    const transform = detectTransform('partner_id', m2oField)
    expect(transform).toEqual({ type: 'passthrough' })
  })

  it('returns passthrough for non-relational field', () => {
    const transform = detectTransform('name', charField)
    expect(transform).toEqual({ type: 'passthrough' })
  })

  it('returns passthrough for non-relational field with /id suffix', () => {
    const transform = detectTransform('name/id', charField)
    expect(transform).toEqual({ type: 'passthrough' })
  })
})

describe('autoMapFieldsRich', () => {
  const fieldsWithRelations: OdooField[] = [
    { name: 'name', type: 'char', string: 'Name', required: true, readonly: false },
    { name: 'partner_id', type: 'many2one', string: 'Partner', required: false, readonly: false, relation: 'res.partner' },
    { name: 'country_id', type: 'many2one', string: 'Country', required: true, readonly: false, relation: 'res.country' },
    { name: 'tag_ids', type: 'many2many', string: 'Tags', required: false, readonly: false, relation: 'res.partner.category' },
    { name: 'email', type: 'char', string: 'Email', required: false, readonly: false },
  ]

  it('returns rich mappings with required from Odoo field', () => {
    const headers = ['name', 'email']
    const mappings = autoMapFieldsRich(headers, fieldsWithRelations)

    const nameMapping = mappings.find(m => m.csvHeader === 'name')
    expect(nameMapping).toBeDefined()
    expect(nameMapping!.required).toBe(true) // name field is required

    const emailMapping = mappings.find(m => m.csvHeader === 'email')
    expect(emailMapping).toBeDefined()
    expect(emailMapping!.required).toBe(false) // email field is not required
  })

  it('auto-detects m2o_ref transform for /id headers', () => {
    const headers = ['partner_id/id']
    const mappings = autoMapFieldsRich(headers, fieldsWithRelations)

    const mapping = mappings.find(m => m.csvHeader === 'partner_id/id')
    expect(mapping).toBeDefined()
    expect(mapping!.transform).toEqual({ type: 'm2o_ref', model: 'res.partner' })
  })

  it('auto-detects db_id transform for /.id headers on standard models', () => {
    const headers = ['country_id/.id']
    const mappings = autoMapFieldsRich(headers, fieldsWithRelations)

    const mapping = mappings.find(m => m.csvHeader === 'country_id/.id')
    expect(mapping).toBeDefined()
    expect(mapping!.transform).toEqual({ type: 'db_id', model: 'res.country' })
    expect(mapping!.required).toBe(true) // country_id is required
  })

  it('auto-detects m2m_ref transform for many2many /id headers', () => {
    const headers = ['tag_ids/id']
    const mappings = autoMapFieldsRich(headers, fieldsWithRelations)

    const mapping = mappings.find(m => m.csvHeader === 'tag_ids/id')
    expect(mapping).toBeDefined()
    expect(mapping!.transform).toEqual({ type: 'm2m_ref', model: 'res.partner.category' })
  })

  it('marks id column as required for upsert', () => {
    const headers = ['id', 'name']
    const mappings = autoMapFieldsRich(headers, fieldsWithRelations)

    const idMapping = mappings.find(m => m.csvHeader === 'id')
    expect(idMapping).toBeDefined()
    expect(idMapping!.required).toBe(true)
    expect(idMapping!.transform).toEqual({ type: 'passthrough' })
  })

  it('returns passthrough transform for regular fields', () => {
    const headers = ['name', 'email']
    const mappings = autoMapFieldsRich(headers, fieldsWithRelations)

    const nameMapping = mappings.find(m => m.csvHeader === 'name')
    expect(nameMapping!.transform).toEqual({ type: 'passthrough' })
  })

  it('includes all matched headers in result', () => {
    const headers = ['id', 'name', 'partner_id/id', 'country_id/.id', 'tag_ids/id']
    const mappings = autoMapFieldsRich(headers, fieldsWithRelations)

    expect(mappings.length).toBe(5)
    expect(mappings.map(m => m.csvHeader)).toContain('id')
    expect(mappings.map(m => m.csvHeader)).toContain('name')
    expect(mappings.map(m => m.csvHeader)).toContain('partner_id/id')
    expect(mappings.map(m => m.csvHeader)).toContain('country_id/.id')
    expect(mappings.map(m => m.csvHeader)).toContain('tag_ids/id')
  })
})

describe('detectTransformFromMapping', () => {
  const m2oField: OdooField = {
    name: 'partner_id',
    type: 'many2one',
    string: 'Partner',
    required: false,
    readonly: false,
    relation: 'res.partner'
  }

  const m2mField: OdooField = {
    name: 'tag_ids',
    type: 'many2many',
    string: 'Tags',
    required: false,
    readonly: false,
    relation: 'res.partner.category'
  }

  const countryField: OdooField = {
    name: 'country_id',
    type: 'many2one',
    string: 'Country',
    required: false,
    readonly: false,
    relation: 'res.country'
  }

  const charField: OdooField = {
    name: 'name',
    type: 'char',
    string: 'Name',
    required: true,
    readonly: false
  }

  it('detects m2o_ref when odooField ends with /id for many2one', () => {
    const transform = detectTransformFromMapping('partner_id/id', m2oField)
    expect(transform).toEqual({ type: 'm2o_ref', model: 'res.partner' })
  })

  it('detects m2m_ref when odooField ends with /id for many2many', () => {
    const transform = detectTransformFromMapping('tag_ids/id', m2mField)
    expect(transform).toEqual({ type: 'm2m_ref', model: 'res.partner.category' })
  })

  it('detects db_id when odooField ends with /.id', () => {
    const transform = detectTransformFromMapping('country_id/.id', countryField)
    expect(transform).toEqual({ type: 'db_id', model: 'res.country' })
  })

  it('returns passthrough for regular odooField', () => {
    const transform = detectTransformFromMapping('partner_id', m2oField)
    expect(transform).toEqual({ type: 'passthrough' })
  })

  it('returns passthrough when field is undefined', () => {
    const transform = detectTransformFromMapping('unknown_field', undefined)
    expect(transform).toEqual({ type: 'passthrough' })
  })

  it('returns passthrough for non-relational field even with /id suffix', () => {
    const transform = detectTransformFromMapping('name/id', charField)
    expect(transform).toEqual({ type: 'passthrough' })
  })

  // Key test: CSV header differs from odoo field
  it('works when CSV header differs from odoo field (German alias)', () => {
    // User maps "land" (German) → "country_id/.id"
    const transform = detectTransformFromMapping('country_id/.id', countryField)
    expect(transform).toEqual({ type: 'db_id', model: 'res.country' })
  })
})

describe('getBaseFieldName', () => {
  it('strips /.id suffix', () => {
    expect(getBaseFieldName('country_id/.id')).toBe('country_id')
  })

  it('strips /id suffix', () => {
    expect(getBaseFieldName('partner_id/id')).toBe('partner_id')
  })

  it('returns field as-is when no suffix', () => {
    expect(getBaseFieldName('name')).toBe('name')
    expect(getBaseFieldName('partner_id')).toBe('partner_id')
  })

  it('handles field names containing id', () => {
    expect(getBaseFieldName('valid_id')).toBe('valid_id')
    expect(getBaseFieldName('product_id')).toBe('product_id')
  })
})

describe('transformValue', () => {
  it('transforms db_id: converts to integer', () => {
    const result = transformValue('42', 'country_id/.id', { type: 'db_id', model: 'res.country' })
    expect(result).toEqual({ field: 'country_id', value: 42 })
  })

  it('transforms m2o_ref: keeps as string', () => {
    const result = transformValue('base.partner_admin', 'partner_id/id', { type: 'm2o_ref', model: 'res.partner' })
    expect(result).toEqual({ field: 'partner_id', value: 'base.partner_admin' })
  })

  it('transforms m2m_ref: keeps as string (pipe-delimited)', () => {
    const result = transformValue('tag_1|tag_2|tag_3', 'tag_ids/id', { type: 'm2m_ref', model: 'res.partner.category' })
    expect(result).toEqual({ field: 'tag_ids', value: 'tag_1|tag_2|tag_3' })
  })

  it('transforms passthrough: keeps field and value as-is', () => {
    const result = transformValue('John Doe', 'name', { type: 'passthrough' })
    expect(result).toEqual({ field: 'name', value: 'John Doe' })
  })

  it('handles id column specially', () => {
    const result = transformValue('res_partner_id#123', 'id', { type: 'passthrough' })
    expect(result).toEqual({ field: '__external_id__', value: 'res_partner_id#123' })
  })

  it('handles .id column specially', () => {
    const result = transformValue('42', '.id', { type: 'passthrough' })
    expect(result).toEqual({ field: '__db_id__', value: 42 })
  })

  it('converts db_id string to integer', () => {
    const result = transformValue('123', 'uom_id/.id', { type: 'db_id', model: 'uom.uom' })
    expect(result.value).toBe(123)
    expect(typeof result.value).toBe('number')
  })
})
