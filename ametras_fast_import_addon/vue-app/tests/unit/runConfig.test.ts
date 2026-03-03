import { describe, it, expect } from 'vitest'
import { createRunConfig } from '@/types/runConfig'

describe('createRunConfig', () => {
  it('creates a RunConfig with correct defaults', () => {
    const before = Date.now()
    const config = createRunConfig(42)
    const after = Date.now()

    expect(config.profileId).toBe(42)
    expect(config.runSettingsOverride).toEqual({})
    expect(config.mappingsOverride.size).toBe(0)
    expect(config.sequenceOverride).toBeNull()
    expect(config.fieldMappingsOverride.size).toBe(0)
    expect(config.createdAt).toBeGreaterThanOrEqual(before)
    expect(config.createdAt).toBeLessThanOrEqual(after)

    const c2 = createRunConfig(42)
    expect(config.id).not.toBe(c2.id)
  })
})

describe('RunConfig override merging', () => {
  it('supports all override types', () => {
    const config = createRunConfig(1)

    config.runSettingsOverride = { batchSize: 500 }
    expect(config.runSettingsOverride.batchSize).toBe(500)

    config.mappingsOverride.set('partners.csv', { model: 'res.company' })
    expect(config.mappingsOverride.get('partners.csv')?.model).toBe('res.company')

    expect(config.sequenceOverride).toBeNull()
    config.sequenceOverride = [
      { order: 1, filename: 'b.csv' },
      { order: 2, filename: 'a.csv' }
    ]
    expect(config.sequenceOverride).toHaveLength(2)
    expect(config.sequenceOverride[0].filename).toBe('b.csv')

    config.fieldMappingsOverride.set('partners.csv', [
      {
        filename: 'partners.csv',
        csvHeader: 'Name',
        odooField: 'display_name',
        required: true,
        transform: { type: 'passthrough' }
      }
    ])
    expect(config.fieldMappingsOverride.get('partners.csv')).toHaveLength(1)
  })
})
