/**
 * CRUD wrapper for storing standalone profiles as ir.attachment records.
 * Profile data is stored as base64-encoded JSON in the `datas` field.
 *
 * Namespace: attachments are identified by a name prefix 'csv_import_profile/'.
 * We do NOT set res_model to a non-existent model — Odoo validates that
 * res_model references a real model and raises AccessError otherwise.
 */

import { useSessionStore } from '@/stores/session'
import type { ImportProfile } from '@/types/importProfile'
import { DEFAULT_RUN_SETTINGS } from '@/stores/config'

const NAME_PREFIX = 'csv_import_profile/'

interface AttachmentRecord {
  id: number
  name: string
  datas: string | false
  create_date: string
  write_date: string
}

function getSessionInfo(): { baseUrl: string; db?: string } {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')
  return { baseUrl: session.baseUrl, db: session.currentServer?.db }
}

async function callKw<T>(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<T> {
  const { baseUrl, db } = getSessionInfo()
  const response = await window.api.odoo.call<T>({
    baseUrl,
    db,
    endpoint: '/web/dataset/call_kw',
    params: { model, method, args, kwargs }
  })
  if (!response.ok) throw new Error(response.error || `Failed to call ${model}.${method}`)
  if (response.result === undefined || response.result === null) throw new Error(`Empty response from ${model}.${method}`)
  return response.result
}

type EncodableProfile = Omit<ImportProfile, 'id' | 'createdAt' | 'updatedAt' | 'isStandalone'>

function encodeProfileData(profile: EncodableProfile): string {
  const json = JSON.stringify(profile)
  // Handle non-ASCII characters
  return btoa(unescape(encodeURIComponent(json)))
}

function decodeProfileData(base64: string): Record<string, unknown> {
  const json = decodeURIComponent(escape(atob(base64)))
  return JSON.parse(json)
}

/**
 * Convert an ir.attachment record to an ImportProfile.
 */
export function attachmentToProfile(rec: AttachmentRecord): ImportProfile {
  const data = rec.datas ? decodeProfileData(rec.datas) : {}
  // Strip the name prefix for display
  const displayName = rec.name.startsWith(NAME_PREFIX)
    ? rec.name.slice(NAME_PREFIX.length)
    : rec.name
  return {
    id: rec.id,
    name: (data.name as string) || displayName,
    version: (data.version as string) || '1.0',
    odooMinVersion: data.odooMinVersion as string | undefined,
    description: data.description as string | undefined,
    mappings: (data.mappings as ImportProfile['mappings']) || [],
    sequence: (data.sequence as ImportProfile['sequence']) || [],
    runSettings: data.runSettings
      ? { ...DEFAULT_RUN_SETTINGS, ...(data.runSettings as Partial<ImportProfile['runSettings']>) }
      : { ...DEFAULT_RUN_SETTINGS },
    fieldMappings: data.fieldMappings as ImportProfile['fieldMappings'],
    richFieldMappings: data.richFieldMappings as ImportProfile['richFieldMappings'],
    createdAt: rec.create_date ? new Date(rec.create_date).getTime() : Date.now(),
    updatedAt: rec.write_date ? new Date(rec.write_date).getTime() : Date.now(),
    isStandalone: true
  }
}

function profileToAttachmentData(profile: ImportProfile): EncodableProfile {
  // Strip runtime-only fields (id, timestamps, isStandalone) before serializing
  const { id: _id, createdAt: _ca, updatedAt: _ua, isStandalone: _is, ...profileData } = profile
  return profileData
}

/**
 * List all standalone profiles stored as ir.attachment records.
 */
export async function listAttachmentProfiles(): Promise<ImportProfile[]> {
  const records = await callKw<AttachmentRecord[]>(
    'ir.attachment',
    'search_read',
    [[['name', '=like', NAME_PREFIX + '%']]],
    { fields: ['id', 'name', 'datas', 'create_date', 'write_date'] }
  )
  return records.map(attachmentToProfile)
}

/**
 * Read a single attachment profile by ID.
 */
export async function getAttachmentProfile(id: number): Promise<ImportProfile | null> {
  const records = await callKw<AttachmentRecord[]>(
    'ir.attachment',
    'read',
    [[id]],
    { fields: ['id', 'name', 'datas', 'create_date', 'write_date'] }
  )
  if (!records || records.length === 0) return null
  return attachmentToProfile(records[0])
}

/**
 * Create a new attachment profile. Returns the created profile with server-assigned ID and timestamps.
 */
export async function createAttachmentProfile(data: EncodableProfile): Promise<ImportProfile> {
  const datas = encodeProfileData(data)
  // Odoo's create returns number[] for list-of-dicts args, or number for a single dict.
  // We pass [dict] here, so number[] is expected — but defend in case the API surface shifts.
  const ids = await callKw<number[] | number>(
    'ir.attachment',
    'create',
    [{ name: NAME_PREFIX + data.name, datas }],
    {}
  )
  const newId = Array.isArray(ids) ? ids[0] : ids
  const profile = await getAttachmentProfile(newId)
  if (!profile) throw new Error('Failed to read back created profile')
  return profile
}

/**
 * Update an existing attachment profile. Merges provided data with existing profile data.
 */
export async function updateAttachmentProfile(id: number, data: Partial<ImportProfile>): Promise<ImportProfile> {
  const existing = await getAttachmentProfile(id)
  if (!existing) throw new Error('Attachment profile not found')

  const merged: ImportProfile = { ...existing, ...data }
  const datas = encodeProfileData(profileToAttachmentData(merged))
  const vals: Record<string, unknown> = { datas }
  if (data.name !== undefined) vals.name = NAME_PREFIX + data.name
  await callKw<boolean>(
    'ir.attachment',
    'write',
    [[id], vals],
    {}
  )
  const updated = await getAttachmentProfile(id)
  if (!updated) throw new Error('Failed to read back updated profile')
  return updated
}

/**
 * Delete an attachment profile.
 */
export async function deleteAttachmentProfile(id: number): Promise<void> {
  await callKw<boolean>(
    'ir.attachment',
    'unlink',
    [[id]],
    {}
  )
}
