import JSZip from 'jszip'
import type { ImportProfile } from '@/types/importProfile'

// ── Profile versioning (merged from profileVersioning.ts) ────────────

export const PROFILE_SCHEMA_VERSION = '1.0'

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

/**
 * Parse a version string like "1.0", "16.0", "16.0.1" into components.
 */
export function parseVersion(version: string): ParsedVersion {
  if (!version || !version.trim()) {
    return { major: 0, minor: 0, patch: 0 }
  }

  // Strip non-numeric suffixes like "+e"
  const cleaned = version.replace(/[^0-9.]/g, '')
  const parts = cleaned.split('.').map(Number)

  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0
  }
}

/**
 * Check if a profile is compatible with the given Odoo server version.
 */
export function checkOdooCompatibility(
  profile: ImportProfile,
  serverVersion: string | null
): { compatible: boolean; reason?: string } {
  if (!profile.odooMinVersion) {
    return { compatible: true }
  }

  if (!serverVersion) {
    return { compatible: true }
  }

  const min = parseVersion(profile.odooMinVersion)
  const server = parseVersion(serverVersion)

  // Compare major first
  if (server.major > min.major) return { compatible: true }
  if (server.major < min.major) {
    return {
      compatible: false,
      reason: `Requires Odoo ${profile.odooMinVersion}+, server is ${serverVersion}`
    }
  }

  // Same major, compare minor
  if (server.minor > min.minor) return { compatible: true }
  if (server.minor < min.minor) {
    return {
      compatible: false,
      reason: `Requires Odoo ${profile.odooMinVersion}+, server is ${serverVersion}`
    }
  }

  // Same major.minor, compare patch
  if (server.patch < min.patch) {
    return {
      compatible: false,
      reason: `Requires Odoo ${profile.odooMinVersion}+, server is ${serverVersion}`
    }
  }

  return { compatible: true }
}

// ── Profile ZIP utilities (merged from profileZip.ts) ────────────────

const REQUIRED_FILES = ['profile.csv', 'mappings.csv', 'sequence.csv']

/**
 * Import a profile from a ZIP file.
 * Extracts CSV files and returns them as a Record<filename, content>.
 */
export async function importProfileFromZip(file: File): Promise<Record<string, string>> {
  const arrayBuffer = await file.arrayBuffer()
  const zip = await JSZip.loadAsync(arrayBuffer)

  const csvFiles: Record<string, string> = {}

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    // Only process CSV files at root level
    const basename = name.split('/').pop() || name
    if (basename.endsWith('.csv')) {
      csvFiles[basename] = await entry.async('string')
    }
  }

  // Validate required files
  for (const required of REQUIRED_FILES) {
    if (!csvFiles[required]) {
      throw new Error(`Missing required file in ZIP: ${required}`)
    }
  }

  return csvFiles
}

/**
 * Export profile CSV files as a ZIP blob.
 */
export async function exportProfileToZip(
  csvFiles: Record<string, string>,
  _profileName: string
): Promise<Blob> {
  const zip = new JSZip()

  for (const [filename, content] of Object.entries(csvFiles)) {
    zip.file(filename, content)
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  return blob
}

/**
 * Trigger a download of a Blob as a file.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
