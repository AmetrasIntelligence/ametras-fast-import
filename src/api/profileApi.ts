import { useSessionStore } from '@/stores/session'
import type { ImportProfile } from '@/types/importProfile'
import { parseTransform } from '@/types/fieldMapping'

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
  mappings: Array<{ filename: string; model: string }>
  sequence: Array<{ order: number; filename: string; requires?: string[] }>
  run_settings: Record<string, string>
  field_mappings: Array<Record<string, unknown>>
}

function getBaseUrl(): string {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')
  return session.baseUrl
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
      lang: (runSettings.lang as string) || 'de_DE'
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
      lang: 'de_DE'
    },
    createdAt: data.created_at ? new Date(data.created_at).getTime() : Date.now(),
    updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : Date.now()
  }
}

/**
 * Upload a profile ZIP file to the server.
 */
export async function uploadProfileZip(filePath: string): Promise<ImportProfile> {
  const baseUrl = getBaseUrl()
  const response = await window.api.profile.upload({ baseUrl, filePath })

  if (!response.ok) {
    throw new Error(response.error || 'Upload failed')
  }

  return toImportProfile(response.result as unknown as ProfileFullData)
}

/**
 * Fetch list of all profiles (summary only, no mappings/sequence data).
 */
export async function fetchProfiles(): Promise<ImportProfile[]> {
  const baseUrl = getBaseUrl()
  const response = await window.api.odoo.call<ProfileListItem[]>({
    baseUrl,
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
  const baseUrl = getBaseUrl()
  const response = await window.api.odoo.call<ProfileFullData>({
    baseUrl,
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
  const baseUrl = getBaseUrl()
  const response = await window.api.odoo.call<{ ok?: boolean; error?: string }>({
    baseUrl,
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
  const baseUrl = getBaseUrl()
  return window.api.profile.export({ baseUrl, profileId, profileName: name })
}
