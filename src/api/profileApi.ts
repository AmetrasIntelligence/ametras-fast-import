import { useSessionStore } from '@/stores/session'
import type { ImportProfile, ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import type { RunSettings } from '@/stores/config'
import { parseTransform, serializeTransform } from '@/types/fieldMapping'
import type { FieldMapping } from '@/types/fieldMapping'

/**
 * Data required to create or update a profile.
 */
export interface ProfileCreateData {
  name: string
  version?: string
  description?: string
  odooMinVersion?: string
  mappings: ProfileMapping[]
  sequence: ProfileSequenceItem[]
  runSettings: Partial<RunSettings>
  fieldMappings?: FieldMapping[]
}

interface ProfileListItem {
  id: number
  name: string
  version: string
  description: string
  odoo_min_version: string
  derived_from: string
  created_at: string
  updated_at: string
}

interface ProfileFullData extends ProfileListItem {
  mappings: Array<{
    filename: string
    model: string
    searchKeys?: string[]
    strict?: boolean
  }>
  sequence: Array<{ order: number; filename: string; requires?: string[] }>
  run_settings: Record<string, string>
  field_mappings: Array<Record<string, unknown>>
}

function getSessionInfo(): { baseUrl: string; db?: string } {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')
  return { baseUrl: session.baseUrl, db: session.currentServer?.db }
}

function toImportProfile(data: ProfileFullData): ImportProfile {
  const runSettings = data.run_settings || {}

  return {
    id: data.id,
    name: data.name,
    version: data.version || '1.0',
    description: data.description || undefined,
    odooMinVersion: data.odoo_min_version || undefined,
    mappings: data.mappings || [],
    sequence: data.sequence || [],
    runSettings: {
      batchSize: parseInt(runSettings.batchSize as string, 10) || 200,
      retryLimit: parseInt(runSettings.retryLimit as string, 10) || 3,
      retryDelayMs: parseInt(runSettings.retryDelayMs as string, 10) || 2000,
      stopOnFatalError: runSettings.stopOnFatalError === 'true',
      encoding: (runSettings.encoding as 'utf-8' | 'utf-8-sig' | 'latin-1' | 'cp1252') || 'utf-8-sig',
      delimiter: (runSettings.delimiter as ',' | ';' | '\t' | '') || ',',
      skipHeader: runSettings.skipHeader !== 'false',
      dryRun: runSettings.dryRun === 'true',
      lang: (runSettings.lang as string) || 'de_DE',
      workers: 1,  // Runtime-only setting, not stored in profile
      strict: runSettings.strict !== 'false',
      legacyImport: runSettings.legacyImport === 'true'
    },
    fieldMappings: data.field_mappings?.filter(
      (fm): fm is { filename: string; csvColumn: string; odooField: string } =>
        'csvColumn' in fm
    ),
    richFieldMappings: data.field_mappings
      ?.filter((fm): fm is Record<string, unknown> & { csvHeader: string } => 'csvHeader' in fm)
      .map(fm => ({
        filename: fm.filename as string,
        csvHeader: fm.csvHeader as string,
        odooField: fm.odooField as string,
        required: fm.required === true,
        transform: parseTransform(fm.transform as string || ''),
        notes: (fm.notes as string) || undefined
      })),
    createdAt: data.created_at ? new Date(data.created_at).getTime() : Date.now(),
    updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : Date.now()
  }
}

function toProfileSummary(data: ProfileListItem): Omit<ImportProfile, 'mappings' | 'sequence' | 'runSettings'> & {
  mappings: []; sequence: []; runSettings: ImportProfile['runSettings']
} {
  return {
    id: data.id,
    name: data.name,
    version: data.version || '1.0',
    description: data.description || undefined,
    odooMinVersion: data.odoo_min_version || undefined,
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
      lang: 'de_DE',
      workers: 1,  // Runtime-only setting, not stored in profile
      strict: true,
      legacyImport: false
    },
    createdAt: data.created_at ? new Date(data.created_at).getTime() : Date.now(),
    updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : Date.now()
  }
}

/**
 * Upload a profile ZIP file to the server.
 */
export async function uploadProfileZip(filePath: string): Promise<ImportProfile> {
  const { baseUrl, db } = getSessionInfo()
  const response = await window.api.profile.upload({ baseUrl, db, filePath })

  if (!response.ok) {
    throw new Error(response.error || 'Upload failed')
  }

  return toImportProfile(response.result as unknown as ProfileFullData)
}

/**
 * Fetch list of all profiles (summary only, no mappings/sequence data).
 */
export async function fetchProfiles(): Promise<ImportProfile[]> {
  const { baseUrl, db } = getSessionInfo()
  const response = await window.api.odoo.call<ProfileListItem[]>({
    baseUrl,
    db,
    endpoint: '/csv_import/profile/list',
    params: {}
  })

  if (!response.ok) {
    throw new Error(response.error || 'Failed to fetch profiles')
  }

  return (response.result || []).map(toProfileSummary)
}

/**
 * Fetch a single profile with full data.
 */
export async function fetchProfile(id: number): Promise<ImportProfile> {
  const { baseUrl, db } = getSessionInfo()
  const response = await window.api.odoo.call<ProfileFullData>({
    baseUrl,
    db,
    endpoint: `/csv_import/profile/${id}`,
    params: {}
  })

  if (!response.ok) {
    throw new Error(response.error || 'Failed to fetch profile')
  }

  const data = response.result!
  if ('error' in data && (data as Record<string, unknown>).error) {
    throw new Error((data as Record<string, unknown>).error as string)
  }

  return toImportProfile(data)
}

/**
 * Delete a profile from the server.
 */
export async function deleteProfile(id: number): Promise<void> {
  const { baseUrl, db } = getSessionInfo()
  const response = await window.api.odoo.call<{ ok?: boolean; error?: string }>({
    baseUrl,
    db,
    endpoint: `/csv_import/profile/${id}/delete`,
    params: {}
  })

  if (!response.ok) {
    throw new Error(response.error || 'Failed to delete profile')
  }

  const data = response.result
  if (data && 'error' in data && data.error) {
    throw new Error(data.error)
  }
}

/**
 * Export a profile as a clean ZIP (server-side download).
 */
export async function exportProfileClean(profileId: number, name: string): Promise<boolean> {
  const { baseUrl, db } = getSessionInfo()
  return window.api.profile.export({ baseUrl, db, profileId, profileName: name })
}

/**
 * Convert frontend field mappings to backend format.
 */
function toBackendFieldMappings(fieldMappings?: FieldMapping[]): Array<Record<string, unknown>> {
  if (!fieldMappings) return []
  return fieldMappings.map(fm => ({
    filename: fm.filename,
    csvHeader: fm.csvHeader,
    odooField: fm.odooField,
    required: fm.required,
    transform: serializeTransform(fm.transform),
    notes: fm.notes || ''
  }))
}

/**
 * Convert frontend run settings to backend format (all values as strings).
 * Note: 'workers' is intentionally NOT included - it's a runtime-only setting
 * that depends on infrastructure/network and should not be stored in profiles.
 */
function toBackendRunSettings(runSettings: Partial<RunSettings>): Record<string, string> {
  const result: Record<string, string> = {}
  if (runSettings.batchSize !== undefined) result.batchSize = String(runSettings.batchSize)
  if (runSettings.retryLimit !== undefined) result.retryLimit = String(runSettings.retryLimit)
  if (runSettings.retryDelayMs !== undefined) result.retryDelayMs = String(runSettings.retryDelayMs)
  if (runSettings.stopOnFatalError !== undefined) result.stopOnFatalError = String(runSettings.stopOnFatalError)
  if (runSettings.encoding !== undefined) result.encoding = runSettings.encoding
  if (runSettings.delimiter !== undefined) result.delimiter = runSettings.delimiter
  if (runSettings.skipHeader !== undefined) result.skipHeader = String(runSettings.skipHeader)
  if (runSettings.dryRun !== undefined) result.dryRun = String(runSettings.dryRun)
  if (runSettings.lang !== undefined) result.lang = runSettings.lang
  if (runSettings.strict !== undefined) result.strict = String(runSettings.strict)
  if (runSettings.legacyImport !== undefined) result.legacyImport = String(runSettings.legacyImport)
  // Note: 'workers' is intentionally omitted - runtime-only, not stored in profiles
  return result
}

/**
 * Create a new profile on the server.
 */
export async function createProfile(data: ProfileCreateData): Promise<ImportProfile> {
  const { baseUrl, db } = getSessionInfo()

  const payload = {
    name: data.name,
    version: data.version || '1.0',
    description: data.description || '',
    odoo_min_version: data.odooMinVersion || '',
    mappings: data.mappings,
    sequence: data.sequence,
    run_settings: toBackendRunSettings(data.runSettings),
    field_mappings: toBackendFieldMappings(data.fieldMappings)
  }

  const response = await window.api.odoo.call<ProfileFullData | { error: string }>({
    baseUrl,
    db,
    endpoint: '/csv_import/profile/create',
    params: { data: payload }
  })

  if (!response.ok) {
    throw new Error(response.error || 'Failed to create profile')
  }

  const result = response.result!
  if ('error' in result && result.error) {
    throw new Error(result.error)
  }

  return toImportProfile(result as ProfileFullData)
}

/**
 * Update an existing profile on the server.
 */
export async function updateProfile(id: number, data: Partial<ProfileCreateData>): Promise<ImportProfile> {
  const { baseUrl, db } = getSessionInfo()

  const payload: Record<string, unknown> = {}
  if (data.name !== undefined) payload.name = data.name
  if (data.version !== undefined) payload.version = data.version
  if (data.description !== undefined) payload.description = data.description
  if (data.odooMinVersion !== undefined) payload.odoo_min_version = data.odooMinVersion
  if (data.mappings !== undefined) payload.mappings = data.mappings
  if (data.sequence !== undefined) payload.sequence = data.sequence
  if (data.runSettings !== undefined) payload.run_settings = toBackendRunSettings(data.runSettings)
  if (data.fieldMappings !== undefined) payload.field_mappings = toBackendFieldMappings(data.fieldMappings)

  const response = await window.api.odoo.call<ProfileFullData | { error: string }>({
    baseUrl,
    db,
    endpoint: `/csv_import/profile/${id}/update`,
    params: { data: payload }
  })

  if (!response.ok) {
    throw new Error(response.error || 'Failed to update profile')
  }

  const result = response.result!
  if ('error' in result && result.error) {
    throw new Error(result.error)
  }

  return toImportProfile(result as ProfileFullData)
}
