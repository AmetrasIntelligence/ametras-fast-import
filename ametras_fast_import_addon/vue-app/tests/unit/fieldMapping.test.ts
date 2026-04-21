import { describe, it, expect } from 'vitest'
import {
  parseTransform,
  serializeTransform,
  STANDARD_DB_ID_MODELS,
  type FieldTransform
} from '@/types/fieldMapping'

describe('parseTransform', () => {
  it('parses all transform types', () => {
    const cases: [unknown, object][] = [
      ['', { type: 'passthrough' }],
      ['  ', { type: 'passthrough' }],
      [undefined, { type: 'passthrough' }],
      ['m2o_ref:product.category', { type: 'm2o_ref', model: 'product.category' }],
      ['m2o_ref:res.partner', { type: 'm2o_ref', model: 'res.partner' }],
      ['m2m_ref:stock.route', { type: 'm2m_ref', model: 'stock.route' }],
      ['db_id:res.country', { type: 'db_id', model: 'res.country' }],
      ['db_id:uom.uom', { type: 'db_id', model: 'uom.uom' }],
    ]
    for (const [input, expected] of cases) {
      expect(parseTransform(input as string)).toEqual(expected)
    }
  })

  it('throws on unknown transform', () => {
    expect(() => parseTransform('unknown:foo')).toThrow('Unknown transform: unknown:foo')
  })
})

describe('serializeTransform', () => {
  it('serializes all transform types', () => {
    const cases: [FieldTransform, string][] = [
      [{ type: 'passthrough' }, ''],
      [{ type: 'm2o_ref', model: 'product.category' }, 'm2o_ref:product.category'],
      [{ type: 'm2m_ref', model: 'stock.route' }, 'm2m_ref:stock.route'],
      [{ type: 'db_id', model: 'res.currency' }, 'db_id:res.currency'],
    ]
    for (const [input, expected] of cases) {
      expect(serializeTransform(input)).toBe(expected)
    }
  })

  it('roundtrips all transform types', () => {
    const transforms: FieldTransform[] = [
      { type: 'passthrough' },
      { type: 'm2o_ref', model: 'res.partner' },
      { type: 'm2m_ref', model: 'product.tag' },
      { type: 'db_id', model: 'uom.uom' },
    ]
    for (const transform of transforms) {
      expect(parseTransform(serializeTransform(transform))).toEqual(transform)
    }
  })
})

describe('STANDARD_DB_ID_MODELS', () => {
  it('contains expected models and excludes others', () => {
    for (const model of ['res.country', 'res.currency', 'uom.uom', 'res.lang']) {
      expect(STANDARD_DB_ID_MODELS.has(model)).toBe(true)
    }
    for (const model of ['product.template', 'res.partner']) {
      expect(STANDARD_DB_ID_MODELS.has(model)).toBe(false)
    }
  })
})
