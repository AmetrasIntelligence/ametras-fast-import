import { describe, it, expect } from 'vitest'
import {
  parseProfileCSV,
  parseMappingsCSV,
  parseSequenceCSV,
  parseFieldMappingsCSV,
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

// Note: Export functions (exportProfileCSV, exportMappingsToCSV, exportSequenceToCSV,
// exportFieldMappingsToCSV, exportRichFieldMappingsToCSV, parseRichFieldMappingsCSV,
// isRichFieldMappingsFormat) were removed from importProfile.ts as unused exports
