/**
 * Standalone profile management.
 *
 * Supports two storage backends:
 * - Local profiles: stored in Electron store with negative IDs (always available, offline-capable)
 * - Server profiles: stored as ir.attachment with positive IDs (available when connected)
 *
 * ZIP imports always create local profiles (no server round-trip needed).
 * UI-created profiles go to ir.attachment for cross-device availability.
 */

import type { ImportProfile, ProfileCreateData, ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import { DEFAULT_RUN_SETTINGS, type RunSettings } from '@/stores/config'
import {
  parseProfileCSV,
  parseMappingsCSV,
  parseSequenceCSV,
  parseFieldMappingsCSV
} from '@/types/importProfile'
import { parseRichFieldMappingsCSV } from '@/api/profileExport'
import { importProfileFromZip } from '@/utils/profileUtils'
import {
  listAttachmentProfiles,
  getAttachmentProfile,
  createAttachmentProfile,
  updateAttachmentProfile,
  deleteAttachmentProfile
} from '@/api/attachmentProfiles'

const STORAGE_KEY = 'standalone-profiles'

// Use negative IDs to distinguish local profiles from server/attachment profile IDs
let nextLocalId = -1

// --- Local (Electron store) helpers ---

async function loadLocalProfiles(): Promise<ImportProfile[]> {
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

async function saveLocalProfiles(profiles: ImportProfile[]): Promise<void> {
  await window.api.store.set(STORAGE_KEY, profiles)
}

// --- Public API ---

/**
 * Load all standalone profiles from both local storage and ir.attachment.
 */
export async function loadStandaloneProfiles(): Promise<ImportProfile[]> {
  const local = await loadLocalProfiles()

  // Try loading server-stored profiles; if it fails (offline, etc.) just use local
  let server: ImportProfile[] = []
  try {
    server = await listAttachmentProfiles()
  } catch {
    // Silently ignore — server profiles unavailable (offline, auth issue, etc.)
  }

  return [...local, ...server]
}

/**
 * Import a profile from a ZIP file and store locally (no server round-trip).
 */
export async function importStandaloneProfile(file: File): Promise<ImportProfile> {
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
  const runSettings: RunSettings = { ...DEFAULT_RUN_SETTINGS }

  if (csvFiles['run_settings.csv']) {
    const lines = csvFiles['run_settings.csv'].trim().split('\n').slice(1)
    for (const line of lines) {
      const idx = line.indexOf(',')
      if (idx > 0) {
        const key = line.substring(0, idx).trim()
        const value = line.substring(idx + 1).trim()

        if (key === 'batchSize') runSettings.batchSize = parseInt(value, 10)
        else if (key === 'encoding') runSettings.encoding = value as RunSettings['encoding']
        else if (key === 'delimiter') runSettings.delimiter = value as RunSettings['delimiter']
        else if (key === 'skipHeader') runSettings.skipHeader = value !== 'false'
        else if (key === 'dryRun') runSettings.dryRun = value === 'true'
        else if (key === 'lang') runSettings.lang = value
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

  // Store locally (no server call needed for ZIP imports)
  const existing = await loadLocalProfiles()
  existing.push(profile)
  await saveLocalProfiles(existing)

  return profile
}

export type StandaloneTarget = 'local' | 'server'

/**
 * Create a standalone profile.
 * target='local' → Electron store (negative ID, offline-capable)
 * target='server' → ir.attachment (positive ID, cross-device)
 */
export async function createStandaloneProfile(data: ProfileCreateData, target: StandaloneTarget = 'server'): Promise<ImportProfile> {
  if (target === 'local') {
    return createLocalProfile(data)
  }
  return createAttachmentProfile({
    name: data.name,
    version: data.version || '1.0',
    odooMinVersion: data.odooMinVersion,
    description: data.description,
    mappings: data.mappings,
    sequence: data.sequence,
    runSettings: { ...DEFAULT_RUN_SETTINGS, ...data.runSettings },
    richFieldMappings: data.fieldMappings
  })
}

/**
 * Create a profile in local Electron store only.
 */
async function createLocalProfile(data: ProfileCreateData): Promise<ImportProfile> {
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

  const existing = await loadLocalProfiles()
  existing.push(profile)
  await saveLocalProfiles(existing)
  return profile
}

/**
 * Push a local profile to server (ir.attachment).
 * Creates a new server copy and removes the local one.
 * Returns the new server-stored profile.
 */
export async function pushProfileToServer(localId: number): Promise<ImportProfile> {
  if (localId >= 0) throw new Error('Only local profiles (negative ID) can be pushed')

  const profiles = await loadLocalProfiles()
  const local = profiles.find(p => p.id === localId)
  if (!local) throw new Error('Local profile not found')

  // Create as ir.attachment
  const serverProfile = await createAttachmentProfile({
    name: local.name,
    version: local.version,
    odooMinVersion: local.odooMinVersion,
    description: local.description,
    mappings: local.mappings,
    sequence: local.sequence,
    runSettings: local.runSettings,
    fieldMappings: local.fieldMappings,
    richFieldMappings: local.richFieldMappings
  })

  // Remove local copy on success
  const filtered = profiles.filter(p => p.id !== localId)
  await saveLocalProfiles(filtered)

  return serverProfile
}

/**
 * Update an existing standalone profile.
 * Routes to local or attachment backend based on ID sign.
 */
export async function updateStandaloneProfile(id: number, data: Partial<ProfileCreateData>): Promise<ImportProfile> {
  // Negative IDs → local Electron store
  if (id < 0) {
    const profiles = await loadLocalProfiles()
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
    await saveLocalProfiles(profiles)
    return updated
  }

  // Positive IDs → ir.attachment
  const updateData: Partial<ImportProfile> = {}
  if (data.name !== undefined) updateData.name = data.name
  if (data.version !== undefined) updateData.version = data.version
  if (data.description !== undefined) updateData.description = data.description
  if (data.odooMinVersion !== undefined) updateData.odooMinVersion = data.odooMinVersion
  if (data.mappings !== undefined) updateData.mappings = data.mappings
  if (data.sequence !== undefined) updateData.sequence = data.sequence
  if (data.runSettings !== undefined) updateData.runSettings = { ...DEFAULT_RUN_SETTINGS, ...data.runSettings }
  if (data.fieldMappings !== undefined) updateData.richFieldMappings = data.fieldMappings

  return updateAttachmentProfile(id, updateData)
}

/**
 * Delete a standalone profile.
 * Routes to local or attachment backend based on ID sign.
 */
export async function deleteStandaloneProfile(id: number): Promise<void> {
  if (id < 0) {
    const profiles = await loadLocalProfiles()
    const filtered = profiles.filter(p => p.id !== id)
    await saveLocalProfiles(filtered)
    return
  }

  return deleteAttachmentProfile(id)
}

/**
 * Get a single standalone profile by ID.
 * Routes to local or attachment backend based on ID sign.
 */
export async function getStandaloneProfile(id: number): Promise<ImportProfile | null> {
  if (id < 0) {
    const profiles = await loadLocalProfiles()
    return profiles.find(p => p.id === id) || null
  }

  return getAttachmentProfile(id)
}
