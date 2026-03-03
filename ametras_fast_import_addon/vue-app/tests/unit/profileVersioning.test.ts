import { describe, it, expect } from 'vitest'
import { parseVersion, checkOdooCompatibility } from '@/utils/profileUtils'
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
  it('parses all version formats', () => {
    const cases: [string, object][] = [
      ['1.0', { major: 1, minor: 0, patch: 0 }],
      ['16.0', { major: 16, minor: 0, patch: 0 }],
      ['16.0.1', { major: 16, minor: 0, patch: 1 }],
      ['', { major: 0, minor: 0, patch: 0 }],
      ['16.0+e', { major: 16, minor: 0, patch: 0 }],
      ['2.3.4', { major: 2, minor: 3, patch: 4 }],
    ]
    for (const [input, expected] of cases) {
      expect(parseVersion(input)).toEqual(expected)
    }
  })
})

describe('checkOdooCompatibility', () => {
  it('checks compatibility for all version scenarios', () => {
    const cases: [Partial<ImportProfile>, string | null, boolean][] = [
      [{ odooMinVersion: undefined }, '16.0', true],
      [{ odooMinVersion: '16.0' }, null, true],
      [{ odooMinVersion: '16.0' }, '16.0+e', true],
      [{ odooMinVersion: '15.0' }, '16.0', true],
      [{ odooMinVersion: '17.0' }, '16.0+e', false],
      [{ odooMinVersion: '16.0.2' }, '16.0.1', false],
      [{ odooMinVersion: '16.0.2' }, '16.0.2', true],
      [{ odooMinVersion: '16.0.2' }, '16.0.3', true],
    ]
    for (const [overrides, serverVersion, expectedCompatible] of cases) {
      const result = checkOdooCompatibility(makeProfile(overrides), serverVersion)
      expect(result.compatible).toBe(expectedCompatible)
      if (!expectedCompatible) {
        expect(result.reason).toBeDefined()
      }
    }
  })
})
