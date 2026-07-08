import { describe, it, expect } from 'vitest'
import { seedDraftFiles, buildFilesSaveData } from '@/utils/profileFiles'
import type { ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'

describe('profileFiles', () => {
  const mappings: ProfileMapping[] = [
    { filename: 'products.csv', model: 'product.template' },
    { filename: 'categories.csv', model: 'product.category' }
  ]
  const sequence: ProfileSequenceItem[] = [
    { order: 1, filename: 'categories.csv' },
    { order: 2, filename: 'products.csv', requires: ['categories.csv'] }
  ]

  it('seeds draft files ordered by sequence, merging model + requires', () => {
    const files = seedDraftFiles(mappings, sequence)
    expect(files.map((f) => f.filename)).toEqual(['categories.csv', 'products.csv'])
    expect(files[0].model).toBe('product.category')
    expect(files[1].model).toBe('product.template')
    expect(files[1].requires).toEqual(['categories.csv'])
  })

  it('preserves extra mapping props (mode, searchKeys, …)', () => {
    const rich: ProfileMapping[] = [
      {
        filename: 'products.csv',
        model: 'product.template',
        mode: 'create_only',
        searchKeys: ['default_code'],
        strict: true
      }
    ]
    const files = seedDraftFiles(rich, [{ order: 1, filename: 'products.csv' }])
    expect(files[0].extra).toMatchObject({
      mode: 'create_only',
      searchKeys: ['default_code'],
      strict: true
    })
    const { mappings: out } = buildFilesSaveData(files)
    expect(out[0]).toMatchObject({
      filename: 'products.csv',
      model: 'product.template',
      mode: 'create_only',
      searchKeys: ['default_code'],
      strict: true
    })
  })

  it('appends mapping-only files after sequenced ones', () => {
    const extra: ProfileMapping[] = [...mappings, { filename: 'extra.csv', model: 'res.partner' }]
    const files = seedDraftFiles(extra, sequence)
    expect(files.map((f) => f.filename)).toEqual([
      'categories.csv',
      'products.csv',
      'extra.csv'
    ])
  })

  it('includes sequence-only files missing from mappings', () => {
    const files = seedDraftFiles([], sequence)
    expect(files.map((f) => f.filename)).toEqual(['categories.csv', 'products.csv'])
    expect(files.every((f) => f.model === '')).toBe(true)
  })

  it('rebuilds sequence order from list position (reorder is preserved)', () => {
    const files = seedDraftFiles(mappings, sequence)
    // Simulate a drag: move products.csv to the front.
    const [moved] = files.splice(1, 1)
    files.unshift(moved)
    const { mappings: outMappings, sequence: outSequence } = buildFilesSaveData(files)
    expect(outSequence).toEqual([
      { order: 1, filename: 'products.csv', requires: ['categories.csv'] },
      { order: 2, filename: 'categories.csv' }
    ])
    expect(outMappings.map((m) => m.filename)).toEqual(['products.csv', 'categories.csv'])
  })

  it('omits requires when empty', () => {
    const files = seedDraftFiles(
      [{ filename: 'a.csv', model: 'res.partner' }],
      [{ order: 1, filename: 'a.csv' }]
    )
    const { sequence: out } = buildFilesSaveData(files)
    expect(out[0]).toEqual({ order: 1, filename: 'a.csv' })
    expect('requires' in out[0]).toBe(false)
  })
})
