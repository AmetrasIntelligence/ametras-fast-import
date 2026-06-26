import type { RunSettings } from '@/stores/config'
import type { FieldMapping } from '@/types/fieldMapping'

/**
 * Data required to create or update a profile.
 * Used by both server (api/profileApi.ts) and standalone (api/profileStorage.ts) backends.
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

export interface ImportProfile {
  id: number
  name: string
  version: string
  odooMinVersion?: string
  description?: string
  mappings: ProfileMapping[]
  sequence: ProfileSequenceItem[]
  runSettings: RunSettings
  fieldMappings?: ProfileFieldMapping[]
  richFieldMappings?: FieldMapping[]
  createdAt: number
  updatedAt: number
  /**
   * Runtime-only flag — true when the profile came from local Electron storage
   * or ir.attachment (standalone client paths). Never persisted: serialization
   * code strips this via `Omit<..., 'isStandalone'>` (see attachmentProfiles.ts).
   */
  isStandalone?: boolean
}

export type ImportMode = 'upsert' | 'create_only'

export interface ProfileMapping {
  filename: string       // or pattern with *
  model: string
  /** Import mode: 'upsert' (default) or 'create_only' */
  mode?: ImportMode
  /** Column name for external ID upsert (e.g., 'id' or 'external_id') */
  externalIdColumn?: string
  /** Field names for natural key search (e.g., ['default_code']) */
  searchKeys?: string[]
  /** If true, fail on missing keys instead of falling back to create */
  strict?: boolean
}

export interface ProfileSequenceItem {
  order: number
  filename: string
  requires?: string[]    // filenames that must come before
}

export interface ProfileFieldMapping {
  filename: string
  csvColumn: string
  odooField: string
}

/**
 * Parse profile metadata from CSV string.
 * Format: key,value
 */
export function parseProfileCSV(csv: string): Partial<ImportProfile> {
  const lines = csv.trim().split('\n').slice(1)
  const profile: Record<string, string> = {}

  for (const line of lines) {
    const idx = line.indexOf(',')
    if (idx > 0) {
      profile[line.substring(0, idx).trim()] = line.substring(idx + 1).trim()
    }
  }

  return {
    name: profile.name,
    version: profile.version || '1.0',
    odooMinVersion: profile.odoo_min_version,
    description: profile.description
  }
}

/**
 * Parse mappings CSV (filename,model).
 */
export function parseMappingsCSV(csv: string): ProfileMapping[] {
  const lines = csv.trim().split('\n').slice(1)
  return lines
    .filter(l => l.trim())
    .map(line => {
      const [filename, model] = line.split(',').map(s => s.trim())
      return { filename, model }
    })
}

/**
 * Parse sequence CSV — supports both v1 (order,filename) and v2 (order,filename,requires) formats.
 */
export function parseSequenceCSV(csv: string): ProfileSequenceItem[] {
  const allLines = csv.trim().split('\n')
  const header = allLines[0]
  const hasRequires = header.includes('requires')
  const lines = allLines.slice(1)

  return lines
    .filter(l => l.trim())
    .map(line => {
      const parts = line.split(',').map(s => s.trim())
      const item: ProfileSequenceItem = {
        order: parseInt(parts[0], 10),
        filename: parts[1]
      }
      if (hasRequires && parts[2]) {
        item.requires = parts[2].split(';').map(s => s.trim()).filter(Boolean)
      }
      return item
    })
    .sort((a, b) => a.order - b.order)
}

/**
 * Parse field mappings CSV (filename,csv_column,odoo_field).
 */
export function parseFieldMappingsCSV(csv: string): ProfileFieldMapping[] {
  const lines = csv.trim().split('\n').slice(1)
  return lines
    .filter(l => l.trim())
    .map(line => {
      const [filename, csvColumn, odooField] = line.split(',').map(s => s.trim())
      return { filename, csvColumn, odooField }
    })
}
