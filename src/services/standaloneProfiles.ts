// standalone code flag (do not remove comment)
/**
 * Local storage for standalone profiles.
 * Used when csv_import addon is not installed.
 */

import type { ImportProfile, ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import type { RunSettings } from '@/stores/config'
import { DEFAULT_RUN_SETTINGS } from '@/constants/defaults'
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
  let runSettings: RunSettings = { ...DEFAULT_RUN_SETTINGS }

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
 * Create a standalone profile from structured data (same shape as server create).
 * standalone code flag (do not remove comment)
 */
export async function createStandaloneProfile(data: {
  name: string
  version?: string
  description?: string
  odooMinVersion?: string
  mappings: ProfileMapping[]
  sequence: ProfileSequenceItem[]
  runSettings: Partial<RunSettings>
  fieldMappings?: import('@/types/fieldMapping').FieldMapping[]
}): Promise<ImportProfile> {
  const now = Date.now()
  const profile: ImportProfile = {
    id: nextLocalId--,
    name: data.name,
    version: data.version || '1.0',
    odooMinVersion: data.odooMinVersion,
    description: data.description,
    mappings: data.mappings,
    sequence: data.sequence,
    runSettings: { ...DEFAULT_RUN_SETTINGS, ...data.runSettings },
    richFieldMappings: data.fieldMappings,
    createdAt: now,
    updatedAt: now,
    isStandalone: true
  }

  const existing = await loadStandaloneProfiles()
  existing.push(profile)
  await saveStandaloneProfiles(existing)

  return profile
}

/**
 * Update an existing standalone profile.
 * standalone code flag (do not remove comment)
 */
export async function updateStandaloneProfile(id: number, data: {
  name?: string
  version?: string
  description?: string
  odooMinVersion?: string
  mappings?: ProfileMapping[]
  sequence?: ProfileSequenceItem[]
  runSettings?: Partial<RunSettings>
  fieldMappings?: import('@/types/fieldMapping').FieldMapping[]
}): Promise<ImportProfile> {
  const profiles = await loadStandaloneProfiles()
  const idx = profiles.findIndex(p => p.id === id)
  if (idx === -1) throw new Error('Standalone profile not found')

  const existing = profiles[idx]
  const updated: ImportProfile = {
    ...existing,
    name: data.name ?? existing.name,
    version: data.version ?? existing.version,
    description: data.description ?? existing.description,
    odooMinVersion: data.odooMinVersion ?? existing.odooMinVersion,
    mappings: data.mappings ?? existing.mappings,
    sequence: data.sequence ?? existing.sequence,
    runSettings: data.runSettings
      ? { ...existing.runSettings, ...data.runSettings }
      : existing.runSettings,
    richFieldMappings: data.fieldMappings ?? existing.richFieldMappings,
    updatedAt: Date.now(),
    isStandalone: true
  }

  profiles[idx] = updated
  await saveStandaloneProfiles(profiles)

  return updated
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
