import JSZip from 'jszip'
import type { ImportProfile, ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import type { FieldMapping } from '@/types/fieldMapping'
import { serializeTransform } from '@/types/fieldMapping'
import type { RunSettings } from '@/stores/config'
import type { RunConfig } from '@/types/runConfig'
import { exportProfileClean } from '@/api/profileApi'
import { downloadBlob } from '@/utils/profileZip'

/**
 * Export a profile, either clean (server download) or with overrides (client-side ZIP).
 */
export async function exportProfile(
  profile: ImportProfile,
  runConfig: RunConfig | null,
  mode: 'clean' | 'with_overrides'
): Promise<void> {
  if (mode === 'clean') {
    await exportProfileClean(profile.id, profile.name)
    return
  }

  if (!runConfig) {
    throw new Error('RunConfig required for export with overrides')
  }

  const merged = applyOverrides(profile, runConfig)
  const zip = new JSZip()

  zip.file('profile.csv', generateProfileCSV(merged))
  zip.file('mappings.csv', generateMappingsCSV(merged.mappings))
  zip.file('sequence.csv', generateSequenceCSV(merged.sequence))
  zip.file('run_settings.csv', generateRunSettingsCSV(merged.runSettings))

  const fieldMappings = merged.richFieldMappings || []
  if (fieldMappings.length > 0) {
    zip.file('field_mappings.csv', generateFieldMappingsCSV(fieldMappings))
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  const safeName = profile.name.replace(/[^a-zA-Z0-9_-]/g, '_')
  downloadBlob(blob, `${safeName}_custom.zip`)
}

/**
 * Increment the minor version of a version string.
 */
export function bumpVersion(version: string): string {
  const parts = version.split('.')
  const major = parseInt(parts[0], 10) || 0
  const minor = parseInt(parts[1], 10) || 0
  return `${major}.${minor + 1}`
}

/**
 * Merge RunConfig overrides into a profile copy.
 */
export function applyOverrides(profile: ImportProfile, runConfig: RunConfig): ImportProfile {
  const merged: ImportProfile = {
    ...profile,
    version: bumpVersion(profile.version),
    runSettings: {
      ...profile.runSettings,
      ...runConfig.runSettingsOverride
    },
    mappings: profile.mappings.map(m => {
      const override = runConfig.mappingsOverride.get(m.filename)
      return override ? { ...m, ...override } : m
    }),
    sequence: runConfig.sequenceOverride !== null
      ? runConfig.sequenceOverride
      : profile.sequence,
    updatedAt: Date.now()
  }

  // Apply field mappings overrides
  if (runConfig.fieldMappingsOverride.size > 0) {
    const base = profile.richFieldMappings || []
    const overriddenFiles = new Set(runConfig.fieldMappingsOverride.keys())
    const kept = base.filter(fm => !overriddenFiles.has(fm.filename))
    const added: FieldMapping[] = []
    for (const [, mappings] of runConfig.fieldMappingsOverride) {
      added.push(...mappings)
    }
    merged.richFieldMappings = [...kept, ...added]
  }

  return merged
}

// ── CSV Generators ────────────────────────────────────────────────

export function generateProfileCSV(profile: ImportProfile): string {
  const lines = ['key,value']
  lines.push(`name,${profile.name}`)
  lines.push(`version,${profile.version}`)
  if (profile.odooMinVersion) lines.push(`odoo_min_version,${profile.odooMinVersion}`)
  if (profile.description) lines.push(`description,${profile.description}`)
  return lines.join('\n')
}

export function generateRunSettingsCSV(settings: RunSettings): string {
  const lines = ['key,value']
  for (const [key, value] of Object.entries(settings)) {
    lines.push(`${key},${value}`)
  }
  return lines.join('\n')
}

export function generateMappingsCSV(mappings: ProfileMapping[]): string {
  const lines = ['filename,model']
  for (const m of mappings) {
    lines.push(`${m.filename},${m.model}`)
  }
  return lines.join('\n')
}

export function generateSequenceCSV(sequence: ProfileSequenceItem[]): string {
  const hasRequires = sequence.some(s => s.requires && s.requires.length > 0)
  if (hasRequires) {
    const lines = ['order,filename,requires']
    for (const s of sequence) {
      const requires = (s.requires || []).join(';')
      lines.push(`${s.order},${s.filename},${requires}`)
    }
    return lines.join('\n')
  }
  const lines = ['order,filename']
  for (const s of sequence) {
    lines.push(`${s.order},${s.filename}`)
  }
  return lines.join('\n')
}

export function generateFieldMappingsCSV(fieldMappings: FieldMapping[]): string {
  const lines = ['filename,csv_header,odoo_field,required,transform,notes']
  for (const m of fieldMappings) {
    lines.push([
      m.filename,
      m.csvHeader,
      m.odooField,
      String(m.required),
      serializeTransform(m.transform),
      m.notes || ''
    ].join(','))
  }
  return lines.join('\n')
}
