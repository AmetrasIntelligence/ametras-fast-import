import type { ImportProfile } from '@/types/importProfile'

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
