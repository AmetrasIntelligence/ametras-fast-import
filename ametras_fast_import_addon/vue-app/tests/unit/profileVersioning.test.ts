import { describe, it, expect } from 'vitest'
import { parseVersion, checkOdooCompatibility, PROFILE_SCHEMA_VERSION } from '@/utils/profileUtils'
import type { ImportProfile } from '@/types/importProfile'

function makeProfile(overrides: Partial<ImportProfile> = {}): ImportProfile {
  return {
    id: 1,
    name: 'Test Profile',
    version: '1.0',
    mappings: [],
    sequence: [],
    runSettings: {
      batchSize: 200,
      retryLimit: 3,
      retryDelayMs: 2000,
      stopOnFatalError: false,
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

describe('parseVersion', () => {
  it('parses simple version "1.0"', () => {
    const v = parseVersion('1.0')
    expect(v).toEqual({ major: 1, minor: 0, patch: 0 })
  })

  it('parses version "16.0"', () => {
    const v = parseVersion('16.0')
    expect(v).toEqual({ major: 16, minor: 0, patch: 0 })
  })

  it('parses version "16.0.1"', () => {
    const v = parseVersion('16.0.1')
    expect(v).toEqual({ major: 16, minor: 0, patch: 1 })
  })

  it('handles empty string', () => {
    const v = parseVersion('')
    expect(v).toEqual({ major: 0, minor: 0, patch: 0 })
  })

  it('handles version with suffix "16.0+e"', () => {
    const v = parseVersion('16.0+e')
    expect(v).toEqual({ major: 16, minor: 0, patch: 0 })
  })

  it('handles version "2.3.4"', () => {
    const v = parseVersion('2.3.4')
    expect(v).toEqual({ major: 2, minor: 3, patch: 4 })
  })
})

describe('checkOdooCompatibility', () => {
  it('returns compatible when no min version is set', () => {
    const profile = makeProfile({ odooMinVersion: undefined })
    const result = checkOdooCompatibility(profile, '16.0')
    expect(result.compatible).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('returns compatible when server version is null', () => {
    const profile = makeProfile({ odooMinVersion: '16.0' })
    const result = checkOdooCompatibility(profile, null)
    expect(result.compatible).toBe(true)
  })

  it('returns compatible when server meets minimum', () => {
    const profile = makeProfile({ odooMinVersion: '16.0' })
    const result = checkOdooCompatibility(profile, '16.0+e')
    expect(result.compatible).toBe(true)
  })

  it('returns compatible when server exceeds minimum', () => {
    const profile = makeProfile({ odooMinVersion: '15.0' })
    const result = checkOdooCompatibility(profile, '16.0')
    expect(result.compatible).toBe(true)
  })

  it('returns incompatible when server is below minimum', () => {
    const profile = makeProfile({ odooMinVersion: '17.0' })
    const result = checkOdooCompatibility(profile, '16.0+e')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('17.0')
    expect(result.reason).toContain('16.0')
  })

  it('handles patch version comparison', () => {
    const profile = makeProfile({ odooMinVersion: '16.0.2' })
    expect(checkOdooCompatibility(profile, '16.0.1').compatible).toBe(false)
    expect(checkOdooCompatibility(profile, '16.0.2').compatible).toBe(true)
    expect(checkOdooCompatibility(profile, '16.0.3').compatible).toBe(true)
  })
})

describe('PROFILE_SCHEMA_VERSION', () => {
  it('is defined', () => {
    expect(PROFILE_SCHEMA_VERSION).toBe('1.0')
  })
})
