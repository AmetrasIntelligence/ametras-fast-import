/**
 * Standalone profile management (server-only).
 *
 * In standalone mode profiles are persisted as server-side `ir.attachment`
 * records, not in local Electron store.
 */

import type { ImportProfile, ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import { DEFAULT_RUN_SETTINGS, type RunSettings } from '@/stores/config'
import {
  parseProfileCSV,
  parseMappingsCSV,
  parseSequenceCSV,
  parseFieldMappingsCSV
} from '@/types/importProfile'
import { parseRichFieldMappingsCSV } from '@/utils/profileExporter'
import { importProfileFromZip } from '@/utils/profileUtils'
import {
  listAttachmentProfiles,
  getAttachmentProfile,
  createAttachmentProfile,
  updateAttachmentProfile,
  deleteAttachmentProfile
} from '@/services/attachmentProfiles'

/**
 * Load all standalone profiles from `ir.attachment`.
 */
export async function loadStandaloneProfiles(): Promise<ImportProfile[]> {
  return listAttachmentProfiles()
}

/**
 * Import a profile from a ZIP file and persist it to `ir.attachment`.
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

  return createAttachmentProfile({
    name: metadata.name || 'Unnamed Profile',
    version: metadata.version || '1.0',
    odooMinVersion: metadata.odooMinVersion,
    description: metadata.description,
    mappings,
    sequence,
    runSettings,
    fieldMappings,
    richFieldMappings
  })
}

interface StandaloneCreateData {
  name: string
  version?: string
  description?: string
  odooMinVersion?: string
  mappings: ProfileMapping[]
  sequence: ProfileSequenceItem[]
  runSettings: Partial<RunSettings>
  fieldMappings?: import('@/types/fieldMapping').FieldMapping[]
}

/**
 * Create a standalone profile in `ir.attachment`.
 */
export async function createStandaloneProfile(data: StandaloneCreateData): Promise<ImportProfile> {
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
 * Update an existing standalone profile.
 * Stored in `ir.attachment`.
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
 * Stored in `ir.attachment`.
 */
export async function deleteStandaloneProfile(id: number): Promise<void> {
  return deleteAttachmentProfile(id)
}

/**
 * Get a single standalone profile by ID.
 * Stored in `ir.attachment`.
 */
export async function getStandaloneProfile(id: number): Promise<ImportProfile | null> {
  return getAttachmentProfile(id)
}
