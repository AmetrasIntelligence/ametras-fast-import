import { describe, it, expect } from 'vitest'
import {
  parseTransform,
  serializeTransform,
  STANDARD_DB_ID_MODELS,
  type FieldTransform
} from '@/types/fieldMapping'

describe('parseTransform', () => {
  it('returns passthrough for empty string', () => {
    expect(parseTransform('')).toEqual({ type: 'passthrough' })
  })

  it('returns passthrough for whitespace-only', () => {
    expect(parseTransform('  ')).toEqual({ type: 'passthrough' })
  })

  it('returns passthrough for undefined-like input', () => {
    expect(parseTransform(undefined as any)).toEqual({ type: 'passthrough' })
  })

  it('parses m2o_ref transform', () => {
    expect(parseTransform('m2o_ref:product.category')).toEqual({
      type: 'm2o_ref',
      model: 'product.category'
    })
  })

  it('parses m2o_ref with dotted model name', () => {
    expect(parseTransform('m2o_ref:res.partner')).toEqual({
      type: 'm2o_ref',
      model: 'res.partner'
    })
  })

  it('parses m2m_ref transform', () => {
    expect(parseTransform('m2m_ref:stock.route')).toEqual({
      type: 'm2m_ref',
      model: 'stock.route'
    })
  })

  it('parses db_id transform', () => {
    expect(parseTransform('db_id:res.country')).toEqual({
      type: 'db_id',
      model: 'res.country'
    })
  })

  it('parses db_id for uom.uom', () => {
    expect(parseTransform('db_id:uom.uom')).toEqual({
      type: 'db_id',
      model: 'uom.uom'
    })
  })

  it('throws on unknown transform', () => {
    expect(() => parseTransform('unknown:foo')).toThrow('Unknown transform: unknown:foo')
  })
})

describe('serializeTransform', () => {
  it('serializes passthrough to empty string', () => {
    expect(serializeTransform({ type: 'passthrough' })).toBe('')
  })

  it('serializes m2o_ref', () => {
    expect(serializeTransform({ type: 'm2o_ref', model: 'product.category' }))
      .toBe('m2o_ref:product.category')
  })

  it('serializes m2m_ref', () => {
    expect(serializeTransform({ type: 'm2m_ref', model: 'stock.route' }))
      .toBe('m2m_ref:stock.route')
  })

  it('serializes db_id', () => {
    expect(serializeTransform({ type: 'db_id', model: 'res.currency' }))
      .toBe('db_id:res.currency')
  })

  it('roundtrips passthrough', () => {
    const transform: FieldTransform = { type: 'passthrough' }
    expect(parseTransform(serializeTransform(transform))).toEqual(transform)
  })

  it('roundtrips m2o_ref', () => {
    const transform: FieldTransform = { type: 'm2o_ref', model: 'res.partner' }
    expect(parseTransform(serializeTransform(transform))).toEqual(transform)
  })

  it('roundtrips m2m_ref', () => {
    const transform: FieldTransform = { type: 'm2m_ref', model: 'product.tag' }
    expect(parseTransform(serializeTransform(transform))).toEqual(transform)
  })

  it('roundtrips db_id', () => {
    const transform: FieldTransform = { type: 'db_id', model: 'uom.uom' }
    expect(parseTransform(serializeTransform(transform))).toEqual(transform)
  })
})

describe('STANDARD_DB_ID_MODELS', () => {
  it('contains res.country', () => {
    expect(STANDARD_DB_ID_MODELS.has('res.country')).toBe(true)
  })

  it('contains res.currency', () => {
    expect(STANDARD_DB_ID_MODELS.has('res.currency')).toBe(true)
  })

  it('contains uom.uom', () => {
    expect(STANDARD_DB_ID_MODELS.has('uom.uom')).toBe(true)
  })

  it('contains res.lang', () => {
    expect(STANDARD_DB_ID_MODELS.has('res.lang')).toBe(true)
  })

  it('does not contain product.template', () => {
    expect(STANDARD_DB_ID_MODELS.has('product.template')).toBe(false)
  })

  it('does not contain res.partner', () => {
    expect(STANDARD_DB_ID_MODELS.has('res.partner')).toBe(false)
  })
})
