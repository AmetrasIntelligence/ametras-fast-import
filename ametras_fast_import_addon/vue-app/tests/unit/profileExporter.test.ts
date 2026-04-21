import { describe, it, expect } from 'vitest'
import {
  bumpVersion,
  applyOverrides,
  generateProfileCSV,
  generateRunSettingsCSV,
  generateMappingsCSV,
  generateSequenceCSV,
  generateFieldMappingsCSV
} from '@/services/profileExporter'
import type { ImportProfile } from '@/types/importProfile'
import { createRunConfig } from '@/types/runConfig'

function makeProfile(overrides: Partial<ImportProfile> = {}): ImportProfile {
  return {
    id: 1,
    name: 'Test Profile',
    version: '1.0',
    mappings: [
      { filename: 'partners.csv', model: 'res.partner' },
      { filename: 'contacts.csv', model: 'res.partner' }
    ],
    sequence: [
      { order: 1, filename: 'partners.csv' },
      { order: 2, filename: 'contacts.csv', requires: ['partners.csv'] }
    ],
    runSettings: {
      batchSize: 200,
      encoding: 'utf-8-sig',
      delimiter: ',',
      skipHeader: true,
      dryRun: false,
      lang: 'de_DE'
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

describe('bumpVersion', () => {
  it('bumps 1.0 to 1.1', () => {
    expect(bumpVersion('1.0')).toBe('1.1')
  })

  it('bumps 2.3 to 2.4', () => {
    expect(bumpVersion('2.3')).toBe('2.4')
  })

  it('bumps 1.9 to 1.10', () => {
    expect(bumpVersion('1.9')).toBe('1.10')
  })

  it('handles single number', () => {
    expect(bumpVersion('1')).toBe('1.1')
  })
})

describe('applyOverrides', () => {
  it('bumps the version', () => {
    const profile = makeProfile()
    const config = createRunConfig(1)
    const merged = applyOverrides(profile, config)
    expect(merged.version).toBe('1.1')
  })

  it('applies run settings overrides', () => {
    const profile = makeProfile()
    const config = createRunConfig(1)
    config.runSettingsOverride = { batchSize: 500, dryRun: true }
    const merged = applyOverrides(profile, config)
    expect(merged.runSettings.batchSize).toBe(500)
    expect(merged.runSettings.dryRun).toBe(true)
    // Non-overridden settings preserved
    expect(merged.runSettings.encoding).toBe('utf-8-sig')
  })

  it('applies mapping overrides', () => {
    const profile = makeProfile()
    const config = createRunConfig(1)
    config.mappingsOverride.set('partners.csv', { model: 'res.company' })
    const merged = applyOverrides(profile, config)
    expect(merged.mappings[0].model).toBe('res.company')
    expect(merged.mappings[1].model).toBe('res.partner') // unchanged
  })

  it('applies sequence override', () => {
    const profile = makeProfile()
    const config = createRunConfig(1)
    config.sequenceOverride = [
      { order: 1, filename: 'contacts.csv' },
      { order: 2, filename: 'partners.csv' }
    ]
    const merged = applyOverrides(profile, config)
    expect(merged.sequence[0].filename).toBe('contacts.csv')
    expect(merged.sequence[1].filename).toBe('partners.csv')
  })

  it('preserves original when no sequence override', () => {
    const profile = makeProfile()
    const config = createRunConfig(1)
    const merged = applyOverrides(profile, config)
    expect(merged.sequence).toEqual(profile.sequence)
  })

  it('does not mutate the original profile', () => {
    const profile = makeProfile()
    const config = createRunConfig(1)
    config.runSettingsOverride = { batchSize: 999 }
    applyOverrides(profile, config)
    expect(profile.runSettings.batchSize).toBe(200)
  })
})

describe('CSV generators', () => {
  it('generateProfileCSV produces valid CSV', () => {
    const profile = makeProfile({ description: 'A test profile', odooMinVersion: '16.0' })
    const csv = generateProfileCSV(profile)
    expect(csv).toContain('key,value')
    expect(csv).toContain('name,Test Profile')
    expect(csv).toContain('version,1.0')
    expect(csv).toContain('odoo_min_version,16.0')
    expect(csv).toContain('description,A test profile')
  })

  it('generateRunSettingsCSV produces valid CSV', () => {
    const csv = generateRunSettingsCSV({
      batchSize: 100,
      encoding: 'utf-8',
      delimiter: ';',
      skipHeader: false,
      dryRun: true,
      lang: 'en_US'
    })
    expect(csv).toContain('key,value')
    expect(csv).toContain('batchSize,100')
    expect(csv).toContain('dryRun,true')
    expect(csv).toContain('lang,en_US')
  })

  it('generateMappingsCSV produces valid CSV', () => {
    const csv = generateMappingsCSV([
      { filename: 'a.csv', model: 'res.partner' },
      { filename: 'b.csv', model: 'res.company' }
    ])
    expect(csv).toContain('filename,model')
    expect(csv).toContain('a.csv,res.partner')
    expect(csv).toContain('b.csv,res.company')
  })

  it('generateSequenceCSV includes requires when present', () => {
    const csv = generateSequenceCSV([
      { order: 1, filename: 'a.csv' },
      { order: 2, filename: 'b.csv', requires: ['a.csv'] }
    ])
    expect(csv).toContain('order,filename,requires')
    expect(csv).toContain('2,b.csv,a.csv')
  })

  it('generateSequenceCSV omits requires header when none present', () => {
    const csv = generateSequenceCSV([
      { order: 1, filename: 'a.csv' },
      { order: 2, filename: 'b.csv' }
    ])
    expect(csv).toBe('order,filename\n1,a.csv\n2,b.csv')
  })

  it('generateFieldMappingsCSV produces rich format', () => {
    const csv = generateFieldMappingsCSV([
      {
        filename: 'partners.csv',
        csvHeader: 'Name',
        odooField: 'name',
        required: true,
        transform: { type: 'passthrough' },
        notes: 'Primary name'
      }
    ])
    expect(csv).toContain('filename,csv_header,odoo_field,required,transform,notes')
    expect(csv).toContain('partners.csv,Name,name,true,,Primary name')
  })
})
