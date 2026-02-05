import { describe, it, expect } from 'vitest'
import {
  parseTransform,
  serializeTransform,
  type FieldMapping,
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

  it('roundtrips passthrough', () => {
    const transform: FieldTransform = { type: 'passthrough' }
    expect(parseTransform(serializeTransform(transform))).toEqual(transform)
  })

  it('roundtrips m2o_ref', () => {
    const transform: FieldTransform = { type: 'm2o_ref', model: 'res.partner' }
    expect(parseTransform(serializeTransform(transform))).toEqual(transform)
  })
})
