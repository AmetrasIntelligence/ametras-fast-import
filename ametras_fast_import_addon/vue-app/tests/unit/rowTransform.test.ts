import { describe, it, expect } from 'vitest'
import { transformRowData } from '@/utils/rowTransform'

describe('transformRowData', () => {
  describe('.id field (database ID)', () => {
    it('parses numeric .id values', () => {
      const result = transformRowData({ col: '42' }, { col: '.id' })
      expect(result).toEqual({ id: 42 })
    })

    it('skips .id when value is non-numeric', () => {
      const result = transformRowData({ col: 'abc' }, { col: '.id' })
      expect(result).toEqual({})
      expect(result).not.toHaveProperty('id')
    })

    it('skips .id when value is empty', () => {
      const result = transformRowData({ col: '' }, { col: '.id' })
      expect(result).toEqual({})
    })
  })

  describe('/.id relational field (database ID)', () => {
    it('parses numeric /.id values', () => {
      const result = transformRowData({ col: '7' }, { col: 'partner_id/.id' })
      expect(result).toEqual({ partner_id: 7 })
    })

    it('skips /.id when value is non-numeric', () => {
      const result = transformRowData({ col: 'not_a_number' }, { col: 'partner_id/.id' })
      expect(result).toEqual({})
      expect(result).not.toHaveProperty('partner_id')
    })

    it('skips /.id when value is empty', () => {
      const result = transformRowData({ col: '' }, { col: 'partner_id/.id' })
      expect(result).toEqual({})
    })
  })

  describe('other fields', () => {
    it('passes through regular fields', () => {
      const result = transformRowData({ col: 'hello' }, { col: 'name' })
      expect(result).toEqual({ name: 'hello' })
    })

    it('handles external id field', () => {
      const result = transformRowData({ col: 'ext_123' }, { col: 'id' })
      expect(result).toEqual({ __external_id__: 'ext_123' })
    })

    it('handles /id relational field', () => {
      const result = transformRowData({ col: 'ext_ref' }, { col: 'partner_id/id' })
      expect(result).toEqual({ partner_id: 'ext_ref' })
    })
  })
})
