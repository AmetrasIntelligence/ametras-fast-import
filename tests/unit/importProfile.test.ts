import { describe, it, expect } from 'vitest'
import {
  parseProfileCSV,
  parseMappingsCSV,
  parseSequenceCSV,
  parseFieldMappingsCSV,
  exportProfileCSV,
  exportMappingsToCSV,
  exportSequenceToCSV,
  exportFieldMappingsToCSV,
  parseRichFieldMappingsCSV,
  exportRichFieldMappingsToCSV,
  isRichFieldMappingsFormat,
  type ImportProfile
} from '@/types/importProfile'

describe('parseProfileCSV', () => {
  it('parses profile metadata', () => {
    const csv = `key,value
name,Standard CRM Import
version,1.0
odoo_min_version,16.0
description,Partners before Contacts`

    const result = parseProfileCSV(csv)
    expect(result.name).toBe('Standard CRM Import')
    expect(result.version).toBe('1.0')
    expect(result.odooMinVersion).toBe('16.0')
    expect(result.description).toBe('Partners before Contacts')
  })

  it('handles missing optional fields', () => {
    const csv = `key,value
name,Simple Import`

    const result = parseProfileCSV(csv)
    expect(result.name).toBe('Simple Import')
    expect(result.version).toBe('1.0')
    expect(result.odooMinVersion).toBeUndefined()
  })

  it('handles empty CSV', () => {
    const csv = 'key,value'
    const result = parseProfileCSV(csv)
    expect(result.name).toBeUndefined()
  })
})

describe('parseMappingsCSV', () => {
  it('parses file-to-model mappings', () => {
    const csv = `filename,model
partners.csv,res.partner
products.csv,product.template`

    const result = parseMappingsCSV(csv)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ filename: 'partners.csv', model: 'res.partner' })
    expect(result[1]).toEqual({ filename: 'products.csv', model: 'product.template' })
  })

  it('handles empty CSV', () => {
    const csv = 'filename,model'
    const result = parseMappingsCSV(csv)
    expect(result).toHaveLength(0)
  })
})

describe('parseSequenceCSV', () => {
  it('parses v2 sequence with dependencies', () => {
    const csv = `order,filename,requires
1,partners.csv,
2,contacts.csv,partners.csv
3,leads.csv,contacts.csv`

    const result = parseSequenceCSV(csv)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ order: 1, filename: 'partners.csv' })
    expect(result[1]).toEqual({ order: 2, filename: 'contacts.csv', requires: ['partners.csv'] })
    expect(result[2]).toEqual({ order: 3, filename: 'leads.csv', requires: ['contacts.csv'] })
  })

  it('parses v1 sequence (no requires column)', () => {
    const csv = `order,filename
1,partners.csv
2,contacts.csv
3,leads.csv`

    const result = parseSequenceCSV(csv)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ order: 1, filename: 'partners.csv' })
    expect(result[1]).toEqual({ order: 2, filename: 'contacts.csv' })
    expect(result[2]).toEqual({ order: 3, filename: 'leads.csv' })
    expect(result[0].requires).toBeUndefined()
    expect(result[1].requires).toBeUndefined()
  })

  it('sorts by order', () => {
    const csv = `order,filename
3,leads.csv
1,partners.csv
2,contacts.csv`

    const result = parseSequenceCSV(csv)
    expect(result[0].filename).toBe('partners.csv')
    expect(result[1].filename).toBe('contacts.csv')
    expect(result[2].filename).toBe('leads.csv')
  })

  it('handles multiple dependencies in v2 format', () => {
    const csv = `order,filename,requires
1,partners.csv,
2,leads.csv,partners.csv;contacts.csv`

    const result = parseSequenceCSV(csv)
    expect(result[1].requires).toEqual(['partners.csv', 'contacts.csv'])
  })
})

describe('parseFieldMappingsCSV', () => {
  it('parses field mappings', () => {
    const csv = `filename,csv_column,odoo_field
partners.csv,name,name
partners.csv,email,email
partners.csv,kunde_nr,ref`

    const result = parseFieldMappingsCSV(csv)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ filename: 'partners.csv', csvColumn: 'name', odooField: 'name' })
    expect(result[2]).toEqual({ filename: 'partners.csv', csvColumn: 'kunde_nr', odooField: 'ref' })
  })
})

describe('export functions', () => {
  const testProfile: ImportProfile = {
    id: 1,
    name: 'Test Profile',
    version: '1.0',
    odooMinVersion: '16.0',
    description: 'Test description',
    mappings: [
      { filename: 'partners.csv', model: 'res.partner' }
    ],
    sequence: [
      { order: 1, filename: 'partners.csv' },
      { order: 2, filename: 'contacts.csv', requires: ['partners.csv'] }
    ],
    runSettings: {
      batchSize: 200,
      retryLimit: 3,
      retryDelayMs: 2000,
      stopOnFatalError: false,
      encoding: 'utf-8-sig' as const,
      delimiter: ',' as const,
      skipHeader: true,
      dryRun: false,
      lang: 'de_DE'
    },
    fieldMappings: [
      { filename: 'partners.csv', csvColumn: 'name', odooField: 'name' }
    ],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  it('exports profile CSV', () => {
    const csv = exportProfileCSV(testProfile)
    expect(csv).toContain('key,value')
    expect(csv).toContain('name,Test Profile')
    expect(csv).toContain('version,1.0')
    expect(csv).toContain('odoo_min_version,16.0')
    expect(csv).toContain('description,Test description')
  })

  it('exports mappings CSV', () => {
    const csv = exportMappingsToCSV(testProfile.mappings)
    expect(csv).toContain('filename,model')
    expect(csv).toContain('partners.csv,res.partner')
  })

  it('exports sequence CSV in v1 format', () => {
    const csv = exportSequenceToCSV(testProfile.sequence)
    expect(csv).toContain('order,filename')
    expect(csv).not.toContain('requires')
    expect(csv).toContain('1,partners.csv')
    expect(csv).toContain('2,contacts.csv')
  })

  it('exports field mappings CSV', () => {
    const csv = exportFieldMappingsToCSV(testProfile.fieldMappings!)
    expect(csv).toContain('filename,csv_column,odoo_field')
    expect(csv).toContain('partners.csv,name,name')
  })

  it('roundtrips profile CSV', () => {
    const csv = exportProfileCSV(testProfile)
    const parsed = parseProfileCSV(csv)
    expect(parsed.name).toBe(testProfile.name)
    expect(parsed.version).toBe(testProfile.version)
    expect(parsed.odooMinVersion).toBe(testProfile.odooMinVersion)
  })

  it('roundtrips mappings CSV', () => {
    const csv = exportMappingsToCSV(testProfile.mappings)
    const parsed = parseMappingsCSV(csv)
    expect(parsed).toEqual(testProfile.mappings)
  })

  it('roundtrips sequence CSV (v1 format drops requires)', () => {
    const csv = exportSequenceToCSV(testProfile.sequence)
    const parsed = parseSequenceCSV(csv)
    expect(parsed[0].order).toBe(1)
    expect(parsed[0].filename).toBe('partners.csv')
    expect(parsed[1].order).toBe(2)
    expect(parsed[1].filename).toBe('contacts.csv')
    // v1 format does not preserve requires
    expect(parsed[1].requires).toBeUndefined()
  })

  it('roundtrips field mappings CSV', () => {
    const csv = exportFieldMappingsToCSV(testProfile.fieldMappings!)
    const parsed = parseFieldMappingsCSV(csv)
    expect(parsed).toEqual(testProfile.fieldMappings)
  })
})

describe('rich field mappings CSV (6-column format)', () => {
  it('parses rich field mappings', () => {
    const csv = `filename,csv_header,odoo_field,required,transform,notes
products.csv,name,name,true,,Product Name
products.csv,categ_id,categ_id,false,m2o_ref:product.category,Category ref`

    const result = parseRichFieldMappingsCSV(csv)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      filename: 'products.csv',
      csvHeader: 'name',
      odooField: 'name',
      required: true,
      transform: { type: 'passthrough' },
      notes: 'Product Name'
    })
    expect(result[1]).toEqual({
      filename: 'products.csv',
      csvHeader: 'categ_id',
      odooField: 'categ_id',
      required: false,
      transform: { type: 'm2o_ref', model: 'product.category' },
      notes: 'Category ref'
    })
  })

  it('handles missing notes', () => {
    const csv = `filename,csv_header,odoo_field,required,transform,notes
test.csv,name,name,true,,`

    const result = parseRichFieldMappingsCSV(csv)
    expect(result[0].notes).toBeUndefined()
  })

  it('exports rich field mappings', () => {
    const mappings = [
      {
        filename: 'test.csv',
        csvHeader: 'sku',
        odooField: 'default_code',
        required: true,
        transform: { type: 'passthrough' as const },
        notes: 'Internal Ref'
      },
      {
        filename: 'test.csv',
        csvHeader: 'categ',
        odooField: 'categ_id',
        required: false,
        transform: { type: 'm2o_ref' as const, model: 'product.category' },
        notes: 'Category'
      }
    ]

    const csv = exportRichFieldMappingsToCSV(mappings)
    expect(csv).toContain('filename,csv_header,odoo_field,required,transform,notes')
    expect(csv).toContain('test.csv,sku,default_code,true,,Internal Ref')
    expect(csv).toContain('test.csv,categ,categ_id,false,m2o_ref:product.category,Category')
  })

  it('roundtrips rich field mappings', () => {
    const original = [
      {
        filename: 'products.csv',
        csvHeader: 'name',
        odooField: 'name',
        required: true,
        transform: { type: 'passthrough' as const },
        notes: 'Product Name'
      },
      {
        filename: 'products.csv',
        csvHeader: 'categ_id',
        odooField: 'categ_id',
        required: false,
        transform: { type: 'm2o_ref' as const, model: 'product.category' }
      }
    ]

    const csv = exportRichFieldMappingsToCSV(original)
    const parsed = parseRichFieldMappingsCSV(csv)

    expect(parsed[0].filename).toBe('products.csv')
    expect(parsed[0].csvHeader).toBe('name')
    expect(parsed[0].odooField).toBe('name')
    expect(parsed[0].required).toBe(true)
    expect(parsed[0].transform).toEqual({ type: 'passthrough' })
    expect(parsed[0].notes).toBe('Product Name')

    expect(parsed[1].transform).toEqual({ type: 'm2o_ref', model: 'product.category' })
  })
})

describe('isRichFieldMappingsFormat', () => {
  it('detects rich format with required column', () => {
    const csv = `filename,csv_header,odoo_field,required,transform,notes
test.csv,name,name,true,,`
    expect(isRichFieldMappingsFormat(csv)).toBe(true)
  })

  it('detects rich format with transform column', () => {
    const csv = `filename,csv_header,odoo_field,required,transform,notes`
    expect(isRichFieldMappingsFormat(csv)).toBe(true)
  })

  it('detects simple format', () => {
    const csv = `filename,csv_column,odoo_field
test.csv,name,name`
    expect(isRichFieldMappingsFormat(csv)).toBe(false)
  })
})
