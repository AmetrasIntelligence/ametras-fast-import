// standalone code flag (do not remove comment)
/**
 * Import mode detection service.
 * Determines whether to use addon mode or standalone mode based on
 * whether the csv_import addon is installed on the Odoo server.
 */

export type ImportMode = 'addon' | 'standalone'

export interface ImportModeInfo {
  mode: ImportMode
  addonVersion?: string
  odooVersion?: string
  limitations: string[]
}

/**
 * Detect which import mode to use based on addon availability.
 * Tries to reach the csv_import addon endpoint first, falls back to standalone.
 */
export async function detectImportMode(
  baseUrl: string,
  db: string
): Promise<ImportModeInfo> {
  try {
    const result = await window.api.standalone.detectAddon({ baseUrl, db })

    if (result.available) {
      return {
        mode: 'addon',
        addonVersion: result.version,
        odooVersion: result.odooVersion,
        limitations: []
      }
    }
  } catch (error) {
    console.warn('Addon detection failed, using standalone mode:', error)
  }

  // Fallback to standalone mode
  const versionResult = await window.api.standalone.getOdooVersion({ baseUrl, db })

  return {
    mode: 'standalone',
    odooVersion: versionResult.version ?? undefined,
    limitations: [
      'Search key upsert not available',
      'Per-row error isolation not available',
      'Explicit operation column (__op__) not supported'
    ]
  }
}
