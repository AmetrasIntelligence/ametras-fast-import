import { describe, it, expect } from 'vitest'
import { createRunConfig } from '@/types/runConfig'

describe('createRunConfig', () => {
  it('creates a RunConfig with correct profileId', () => {
    const config = createRunConfig(42)
    expect(config.profileId).toBe(42)
  })

  it('creates with empty overrides', () => {
    const config = createRunConfig(1)
    expect(config.runSettingsOverride).toEqual({})
    expect(config.mappingsOverride.size).toBe(0)
    expect(config.sequenceOverride).toBeNull()
    expect(config.fieldMappingsOverride.size).toBe(0)
  })

  it('generates a unique id', () => {
    const c1 = createRunConfig(1)
    const c2 = createRunConfig(1)
    expect(c1.id).not.toBe(c2.id)
  })

  it('sets createdAt to current time', () => {
    const before = Date.now()
    const config = createRunConfig(1)
    const after = Date.now()
    expect(config.createdAt).toBeGreaterThanOrEqual(before)
    expect(config.createdAt).toBeLessThanOrEqual(after)
  })
})

describe('RunConfig override merging', () => {
  it('supports setting run settings overrides', () => {
    const config = createRunConfig(1)
    config.runSettingsOverride = { batchSize: 500 }
    expect(config.runSettingsOverride.batchSize).toBe(500)
  })

  it('supports mapping overrides', () => {
    const config = createRunConfig(1)
    config.mappingsOverride.set('partners.csv', { model: 'res.company' })
    expect(config.mappingsOverride.get('partners.csv')?.model).toBe('res.company')
  })

  it('supports sequence override (replaces entirely)', () => {
    const config = createRunConfig(1)
    expect(config.sequenceOverride).toBeNull()

    config.sequenceOverride = [
      { order: 1, filename: 'b.csv' },
      { order: 2, filename: 'a.csv' }
    ]
    expect(config.sequenceOverride).toHaveLength(2)
    expect(config.sequenceOverride[0].filename).toBe('b.csv')
  })

  it('supports field mappings override per file', () => {
    const config = createRunConfig(1)
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

describe('hasOverrides detection', () => {
  it('detects no overrides on fresh config', () => {
    const config = createRunConfig(1)
    const has =
      Object.keys(config.runSettingsOverride).length > 0 ||
      config.mappingsOverride.size > 0 ||
      config.sequenceOverride !== null ||
      config.fieldMappingsOverride.size > 0
    expect(has).toBe(false)
  })

  it('detects run settings override', () => {
    const config = createRunConfig(1)
    config.runSettingsOverride = { dryRun: true }
    expect(Object.keys(config.runSettingsOverride).length > 0).toBe(true)
  })

  it('detects mapping override', () => {
    const config = createRunConfig(1)
    config.mappingsOverride.set('a.csv', { model: 'x' })
    expect(config.mappingsOverride.size > 0).toBe(true)
  })

  it('detects sequence override', () => {
    const config = createRunConfig(1)
    config.sequenceOverride = []
    expect(config.sequenceOverride !== null).toBe(true)
  })
})
