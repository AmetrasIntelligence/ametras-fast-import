import { describe, it, expect } from 'vitest'
import { transformRowWithMappings, validateRowRequiredFields } from '@/importer/batchExecutor'
import type { FieldMapping } from '@/types/fieldMapping'
import type { ParsedRow } from '@/importer/csvParser'

function makeRow(data: Record<string, string>, index = 1): ParsedRow {
  return { index, data, raw: Object.values(data) }
}

describe('transformRowWithMappings', () => {
  const mappings: FieldMapping[] = [
    { filename: 'products.csv', csvHeader: 'sku', odooField: 'default_code', required: true, transform: { type: 'passthrough' } },
    { filename: 'products.csv', csvHeader: 'name', odooField: 'name', required: true, transform: { type: 'passthrough' } },
    { filename: 'products.csv', csvHeader: 'categ', odooField: 'categ_id', required: false, transform: { type: 'm2o_ref', model: 'product.category' } },
    { filename: 'other.csv', csvHeader: 'name', odooField: 'name', required: true, transform: { type: 'passthrough' } },
  ]

  it('transforms row using mappings for the correct file', () => {
    const row = makeRow({ sku: 'PROD-001', name: 'Widget', categ: 'cat_1' })
    const result = transformRowWithMappings(row, mappings, 'products.csv')

    expect(result).toEqual({
      default_code: 'PROD-001',
      name: 'Widget',
      categ_id: 'cat_1'
    })
  })

  it('skips empty values', () => {
    const row = makeRow({ sku: 'PROD-001', name: '', categ: '' })
    const result = transformRowWithMappings(row, mappings, 'products.csv')

    expect(result).toEqual({ default_code: 'PROD-001' })
  })

  it('skips undefined values', () => {
    const row = makeRow({ sku: 'PROD-001' })
    const result = transformRowWithMappings(row, mappings, 'products.csv')

    expect(result).toEqual({ default_code: 'PROD-001' })
  })

  it('ignores mappings for other files', () => {
    const row = makeRow({ name: 'Test' })
    const result = transformRowWithMappings(row, mappings, 'other.csv')

    expect(result).toEqual({ name: 'Test' })
    expect(result).not.toHaveProperty('default_code')
  })

  it('returns empty object when no mappings match', () => {
    const row = makeRow({ name: 'Test' })
    const result = transformRowWithMappings(row, mappings, 'nonexistent.csv')

    expect(result).toEqual({})
  })

  it('passes m2o_ref values through as strings', () => {
    const row = makeRow({ sku: 'X', name: 'Y', categ: 'product_category_ref_123' })
    const result = transformRowWithMappings(row, mappings, 'products.csv')

    expect(result.categ_id).toBe('product_category_ref_123')
  })
})

describe('validateRowRequiredFields', () => {
  const mappings: FieldMapping[] = [
    { filename: 'test.csv', csvHeader: 'id', odooField: 'id', required: true, transform: { type: 'passthrough' } },
    { filename: 'test.csv', csvHeader: 'name', odooField: 'name', required: true, transform: { type: 'passthrough' } },
    { filename: 'test.csv', csvHeader: 'email', odooField: 'email', required: false, transform: { type: 'passthrough' } },
  ]

  it('returns valid when all required fields present', () => {
    const row = makeRow({ id: '1', name: 'Test', email: 'test@test.com' })
    const result = validateRowRequiredFields(row, mappings, 'test.csv')

    expect(result.valid).toBe(true)
    expect(result.missingFields).toHaveLength(0)
  })

  it('returns invalid with missing required fields', () => {
    const row = makeRow({ id: '1' })
    const result = validateRowRequiredFields(row, mappings, 'test.csv')

    expect(result.valid).toBe(false)
    expect(result.missingFields).toEqual(['name'])
  })

  it('does not flag missing optional fields', () => {
    const row = makeRow({ id: '1', name: 'Test' })
    const result = validateRowRequiredFields(row, mappings, 'test.csv')

    expect(result.valid).toBe(true)
  })

  it('treats empty string as missing for required fields', () => {
    const row = makeRow({ id: '1', name: '' })
    const result = validateRowRequiredFields(row, mappings, 'test.csv')

    expect(result.valid).toBe(false)
    expect(result.missingFields).toEqual(['name'])
  })

  it('returns valid for files with no mappings', () => {
    const row = makeRow({ id: '1' })
    const result = validateRowRequiredFields(row, mappings, 'other.csv')

    expect(result.valid).toBe(true)
  })
})
