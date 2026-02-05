import type { RunSettings } from '@/stores/config'
import type { FieldMapping } from '@/types/fieldMapping'
import { parseTransform, serializeTransform } from '@/types/fieldMapping'

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
}

export interface ProfileMapping {
  filename: string       // or pattern with *
  model: string
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

/**
 * Export profile metadata to CSV.
 */
export function exportProfileCSV(profile: ImportProfile): string {
  const lines = ['key,value']
  lines.push(`name,${profile.name}`)
  lines.push(`version,${profile.version}`)
  if (profile.odooMinVersion) lines.push(`odoo_min_version,${profile.odooMinVersion}`)
  if (profile.description) lines.push(`description,${profile.description}`)
  return lines.join('\n')
}

/**
 * Export mappings to CSV.
 */
export function exportMappingsToCSV(mappings: ProfileMapping[]): string {
  const lines = ['filename,model']
  for (const m of mappings) {
    lines.push(`${m.filename},${m.model}`)
  }
  return lines.join('\n')
}

/**
 * Export sequence to CSV (v1 format: order,filename only).
 */
export function exportSequenceToCSV(sequence: ProfileSequenceItem[]): string {
  const lines = ['order,filename']
  for (const s of sequence) {
    lines.push(`${s.order},${s.filename}`)
  }
  return lines.join('\n')
}

/**
 * Export field mappings to CSV (simple 3-column format).
 */
export function exportFieldMappingsToCSV(fieldMappings: ProfileFieldMapping[]): string {
  const lines = ['filename,csv_column,odoo_field']
  for (const fm of fieldMappings) {
    lines.push(`${fm.filename},${fm.csvColumn},${fm.odooField}`)
  }
  return lines.join('\n')
}

/**
 * Parse rich field mappings CSV (6-column format: filename,csv_header,odoo_field,required,transform,notes).
 */
export function parseRichFieldMappingsCSV(csv: string): FieldMapping[] {
  const lines = csv.trim().split('\n').slice(1)
  return lines
    .filter(l => l.trim())
    .map(line => {
      const [filename, csvHeader, odooField, required, transform, ...notesParts] = line.split(',').map(s => s.trim())
      return {
        filename,
        csvHeader,
        odooField,
        required: required?.toLowerCase() === 'true',
        transform: parseTransform(transform || ''),
        notes: notesParts.join(',').trim() || undefined
      }
    })
}

/**
 * Export rich field mappings to CSV (6-column format).
 */
export function exportRichFieldMappingsToCSV(fieldMappings: FieldMapping[]): string {
  const lines = ['filename,csv_header,odoo_field,required,transform,notes']
  for (const m of fieldMappings) {
    lines.push([
      m.filename,
      m.csvHeader,
      m.odooField,
      m.required,
      serializeTransform(m.transform),
      m.notes || ''
    ].join(','))
  }
  return lines.join('\n')
}

/**
 * Detect whether a field_mappings.csv uses the rich (6-column) or simple (3-column) format.
 */
export function isRichFieldMappingsFormat(csv: string): boolean {
  const header = csv.trim().split('\n')[0] || ''
  return header.includes('required') || header.includes('transform')
}
