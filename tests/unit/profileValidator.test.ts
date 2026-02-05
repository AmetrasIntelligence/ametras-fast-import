import { describe, it, expect } from 'vitest'
import { validateProfile, checkVersionCompatibility, validateProfileDraft, type ProfileDraft } from '@/importer/profileValidator'
import type { ImportProfile } from '@/types/importProfile'

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
      batchSize: 100,
      retryLimit: 3,
      retryDelayMs: 2000,
      stopOnFatalError: false
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

describe('validateProfile', () => {
  it('returns no errors for a valid profile', () => {
    const profile = makeProfile()
    const errors = validateProfile(profile, ['partners.csv', 'contacts.csv'])
    expect(errors).toHaveLength(0)
  })

  it('detects missing files', () => {
    const profile = makeProfile()
    const errors = validateProfile(profile, ['partners.csv'])
    const missingFile = errors.find(e => e.type === 'missing_file' && e.filename === 'contacts.csv')
    expect(missingFile).toBeDefined()
  })

  it('detects files mapped but not in sequence', () => {
    const profile = makeProfile({
      mappings: [
        { filename: 'partners.csv', model: 'res.partner' },
        { filename: 'contacts.csv', model: 'res.partner' },
        { filename: 'extra.csv', model: 'res.bank' }
      ]
    })
    const errors = validateProfile(profile, ['partners.csv', 'contacts.csv', 'extra.csv'])
    const gapError = errors.find(e => e.type === 'sequence_gap' && e.filename === 'extra.csv')
    expect(gapError).toBeDefined()
  })

  it('detects files in sequence without model mapping', () => {
    const profile = makeProfile({
      sequence: [
        { order: 1, filename: 'partners.csv' },
        { order: 2, filename: 'contacts.csv', requires: ['partners.csv'] },
        { order: 3, filename: 'extra.csv' }
      ]
    })
    const errors = validateProfile(profile, ['partners.csv', 'contacts.csv', 'extra.csv'])
    const missingModel = errors.find(e => e.type === 'missing_model' && e.filename === 'extra.csv')
    expect(missingModel).toBeDefined()
  })

  it('detects dependency violations', () => {
    const profile = makeProfile({
      sequence: [
        { order: 1, filename: 'contacts.csv', requires: ['partners.csv'] },
        { order: 2, filename: 'partners.csv' }
      ]
    })
    const errors = validateProfile(profile, ['partners.csv', 'contacts.csv'])
    const depError = errors.find(e => e.type === 'dependency_violation')
    expect(depError).toBeDefined()
    expect(depError!.message).toContain('partners.csv')
  })

  it('detects circular dependencies', () => {
    const profile = makeProfile({
      sequence: [
        { order: 1, filename: 'a.csv', requires: ['b.csv'] },
        { order: 2, filename: 'b.csv', requires: ['a.csv'] }
      ],
      mappings: [
        { filename: 'a.csv', model: 'res.partner' },
        { filename: 'b.csv', model: 'res.partner' }
      ]
    })
    const errors = validateProfile(profile, ['a.csv', 'b.csv'])
    const circular = errors.find(e => e.type === 'circular_dependency')
    expect(circular).toBeDefined()
  })

  it('supports glob patterns in filenames', () => {
    const profile = makeProfile({
      sequence: [
        { order: 1, filename: '*_partners.csv' }
      ],
      mappings: [
        { filename: '*_partners.csv', model: 'res.partner' }
      ]
    })
    const errors = validateProfile(profile, ['2024_partners.csv'])
    const missing = errors.filter(e => e.type === 'missing_file')
    expect(missing).toHaveLength(0)
  })

  it('reports missing when glob has no match', () => {
    const profile = makeProfile({
      sequence: [
        { order: 1, filename: '*_partners.csv' }
      ],
      mappings: [
        { filename: '*_partners.csv', model: 'res.partner' }
      ]
    })
    const errors = validateProfile(profile, ['contacts.csv'])
    const missing = errors.find(e => e.type === 'missing_file')
    expect(missing).toBeDefined()
  })

  it('handles empty profile gracefully', () => {
    const profile = makeProfile({
      mappings: [],
      sequence: []
    })
    const errors = validateProfile(profile, [])
    expect(errors).toHaveLength(0)
  })

  it('validates profile with no dependencies', () => {
    const profile = makeProfile({
      sequence: [
        { order: 1, filename: 'partners.csv' },
        { order: 2, filename: 'contacts.csv' }
      ]
    })
    const errors = validateProfile(profile, ['partners.csv', 'contacts.csv'])
    expect(errors).toHaveLength(0)
  })
})

describe('checkVersionCompatibility', () => {
  it('returns true when no min version is set', () => {
    const profile = makeProfile({ odooMinVersion: undefined })
    expect(checkVersionCompatibility(profile, '16.0')).toBe(true)
  })

  it('returns true when server version is null', () => {
    const profile = makeProfile({ odooMinVersion: '16.0' })
    expect(checkVersionCompatibility(profile, null)).toBe(true)
  })

  it('returns true when server meets minimum', () => {
    const profile = makeProfile({ odooMinVersion: '16.0' })
    expect(checkVersionCompatibility(profile, '16.0+e')).toBe(true)
  })

  it('returns true when server exceeds minimum', () => {
    const profile = makeProfile({ odooMinVersion: '15.0' })
    expect(checkVersionCompatibility(profile, '16.0+e')).toBe(true)
  })

  it('returns false when server is below minimum', () => {
    const profile = makeProfile({ odooMinVersion: '17.0' })
    expect(checkVersionCompatibility(profile, '16.0+e')).toBe(false)
  })
})

describe('validateProfileDraft', () => {
  function makeDraft(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
    return {
      meta: { name: 'Test Draft', version: '1.0' },
      mappings: [
        { filename: 'partners.csv', model: 'res.partner' }
      ],
      sequence: [
        { order: 1, filename: 'partners.csv' }
      ],
      fieldMappings: [],
      ...overrides
    }
  }

  it('returns valid for a well-formed draft', () => {
    const result = validateProfileDraft(makeDraft())
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('detects missing name', () => {
    const result = validateProfileDraft(makeDraft({ meta: {} }))
    expect(result.valid).toBe(false)
    const nameError = result.errors.find(e => e.type === 'missing_name')
    expect(nameError).toBeDefined()
  })

  it('detects empty name', () => {
    const result = validateProfileDraft(makeDraft({ meta: { name: '   ' } }))
    expect(result.valid).toBe(false)
  })

  it('detects duplicate filenames in mappings', () => {
    const result = validateProfileDraft(makeDraft({
      mappings: [
        { filename: 'a.csv', model: 'res.partner' },
        { filename: 'a.csv', model: 'res.company' }
      ]
    }))
    expect(result.valid).toBe(false)
    const dupError = result.errors.find(e => e.type === 'duplicate_filename')
    expect(dupError).toBeDefined()
  })

  it('warns on unmapped sequence files', () => {
    const result = validateProfileDraft(makeDraft({
      sequence: [
        { order: 1, filename: 'partners.csv' },
        { order: 2, filename: 'unknown.csv' }
      ]
    }))
    expect(result.valid).toBe(true) // warnings don't invalidate
    const warning = result.warnings.find(e => e.type === 'unmapped_sequence')
    expect(warning).toBeDefined()
    expect(warning!.filename).toBe('unknown.csv')
  })

  it('warns on orphan mappings (mapped but not in sequence)', () => {
    const result = validateProfileDraft(makeDraft({
      mappings: [
        { filename: 'partners.csv', model: 'res.partner' },
        { filename: 'extra.csv', model: 'res.bank' }
      ],
      sequence: [
        { order: 1, filename: 'partners.csv' }
      ]
    }))
    expect(result.valid).toBe(true)
    const warning = result.warnings.find(e => e.type === 'orphan_mapping')
    expect(warning).toBeDefined()
    expect(warning!.filename).toBe('extra.csv')
  })

  it('warns on orphan field mappings', () => {
    const result = validateProfileDraft(makeDraft({
      fieldMappings: [
        {
          filename: 'nonexistent.csv',
          csvHeader: 'Name',
          odooField: 'name',
          required: false,
          transform: { type: 'passthrough' }
        }
      ]
    }))
    expect(result.valid).toBe(true)
    const warning = result.warnings.find(e => e.type === 'orphan_field_mapping')
    expect(warning).toBeDefined()
  })

  it('warns on non-contiguous order numbers', () => {
    const result = validateProfileDraft(makeDraft({
      sequence: [
        { order: 1, filename: 'a.csv' },
        { order: 5, filename: 'b.csv' }
      ],
      mappings: [
        { filename: 'a.csv', model: 'res.partner' },
        { filename: 'b.csv', model: 'res.partner' }
      ]
    }))
    const warning = result.warnings.find(e => e.type === 'non_contiguous_order')
    expect(warning).toBeDefined()
  })

  it('handles empty draft', () => {
    const result = validateProfileDraft({
      meta: { name: 'Empty' },
      mappings: [],
      sequence: [],
      fieldMappings: []
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })
})
