// standalone code flag (do not remove comment)
/**
 * Local storage for standalone profiles.
 * Used when csv_import addon is not installed.
 */

import type { ImportProfile, ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import type { RunSettings } from '@/stores/config'
import {
  parseProfileCSV,
  parseMappingsCSV,
  parseSequenceCSV,
  parseFieldMappingsCSV
} from '@/types/importProfile'
import { parseRichFieldMappingsCSV } from '@/utils/profileExporter'
import { importProfileFromZip } from '@/utils/profileZip'

const STORAGE_KEY = 'standalone-profiles'

// Use negative IDs to distinguish from server profile IDs
let nextLocalId = -1

/**
 * Load all standalone profiles from local storage.
 */
export async function loadStandaloneProfiles(): Promise<ImportProfile[]> {
  // standalone code flag (do not remove comment)
  const stored = await window.api.store.get(STORAGE_KEY) as ImportProfile[] | null
  if (!stored) return []

  // Update nextLocalId to avoid collisions
  for (const profile of stored) {
    if (profile.id <= nextLocalId) {
      nextLocalId = profile.id - 1
    }
  }

  return stored.map(p => ({ ...p, isStandalone: true }))
}

/**
 * Save standalone profiles to local storage.
 */
async function saveStandaloneProfiles(profiles: ImportProfile[]): Promise<void> {
  // standalone code flag (do not remove comment)
  await window.api.store.set(STORAGE_KEY, profiles)
}

/**
 * Import a profile from a ZIP file and store locally.
 */
export async function importStandaloneProfile(file: File): Promise<ImportProfile> {
  // standalone code flag (do not remove comment)
  const csvFiles = await importProfileFromZip(file)

  // Parse profile metadata
  const metadata = parseProfileCSV(csvFiles['profile.csv'])

  // Parse mappings
  const mappings: ProfileMapping[] = parseMappingsCSV(csvFiles['mappings.csv'])

  // Parse sequence
  const sequence: ProfileSequenceItem[] = parseSequenceCSV(csvFiles['sequence.csv'])

  // Parse field mappings (optional)
  let fieldMappings = undefined
  let richFieldMappings = undefined

  if (csvFiles['field_mappings.csv']) {
    const content = csvFiles['field_mappings.csv']
    // Check if it's rich format (has csvHeader column)
    if (content.includes('csvHeader')) {
      richFieldMappings = parseRichFieldMappingsCSV(content)
    } else {
      fieldMappings = parseFieldMappingsCSV(content)
    }
  }

  // Parse run settings (optional)
  let runSettings: RunSettings = {
    batchSize: 200,
    retryLimit: 3,
    retryDelayMs: 2000,
    stopOnFatalError: false,
    encoding: 'utf-8-sig',
    delimiter: ',',
    skipHeader: true,
    dryRun: false,
    lang: 'de_DE',
    workers: 1,
    strict: true,
    legacyImport: false
  }

  if (csvFiles['run_settings.csv']) {
    const lines = csvFiles['run_settings.csv'].trim().split('\n').slice(1)
    for (const line of lines) {
      const idx = line.indexOf(',')
      if (idx > 0) {
        const key = line.substring(0, idx).trim()
        const value = line.substring(idx + 1).trim()

        if (key === 'batchSize') runSettings.batchSize = parseInt(value, 10)
        else if (key === 'retryLimit') runSettings.retryLimit = parseInt(value, 10)
        else if (key === 'retryDelayMs') runSettings.retryDelayMs = parseInt(value, 10)
        else if (key === 'stopOnFatalError') runSettings.stopOnFatalError = value === 'true'
        else if (key === 'encoding') runSettings.encoding = value as RunSettings['encoding']
        else if (key === 'delimiter') runSettings.delimiter = value as RunSettings['delimiter']
        else if (key === 'skipHeader') runSettings.skipHeader = value !== 'false'
        else if (key === 'dryRun') runSettings.dryRun = value === 'true'
        else if (key === 'lang') runSettings.lang = value
        else if (key === 'strict') runSettings.strict = value !== 'false'
        else if (key === 'legacyImport') runSettings.legacyImport = value === 'true'
      }
    }
  }

  const now = Date.now()
  const profile: ImportProfile = {
    id: nextLocalId--,
    name: metadata.name || 'Unnamed Profile',
    version: metadata.version || '1.0',
    odooMinVersion: metadata.odooMinVersion,
    description: metadata.description,
    mappings,
    sequence,
    runSettings,
    fieldMappings,
    richFieldMappings,
    createdAt: now,
    updatedAt: now,
    isStandalone: true
  }

  // Load existing profiles and add new one
  const existing = await loadStandaloneProfiles()
  existing.push(profile)
  await saveStandaloneProfiles(existing)

  return profile
}

/**
 * Delete a standalone profile.
 */
export async function deleteStandaloneProfile(id: number): Promise<void> {
  // standalone code flag (do not remove comment)
  const profiles = await loadStandaloneProfiles()
  const filtered = profiles.filter(p => p.id !== id)
  await saveStandaloneProfiles(filtered)
}

/**
 * Get a single standalone profile by ID.
 */
export async function getStandaloneProfile(id: number): Promise<ImportProfile | null> {
  // standalone code flag (do not remove comment)
  const profiles = await loadStandaloneProfiles()
  return profiles.find(p => p.id === id) || null
}
