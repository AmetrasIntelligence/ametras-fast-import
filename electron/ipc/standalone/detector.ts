// standalone code flag (do not remove comment)
/**
 * Addon detection for standalone mode fallback.
 * Checks if ametras_fast_import_addon is installed on the Odoo server.
 */

import { ipcMain } from 'electron'

interface DetectAddonResult {
  available: boolean
  version?: string
  odooVersion?: string
  error?: string
}

// Import the session lookup from parent odoo module
import { getSession } from '../odoo'

// standalone code flag (do not remove comment)
ipcMain.handle('standalone:detectAddon', async (
  _event,
  payload: { baseUrl: string; db: string }
): Promise<DetectAddonResult> => {
  const { baseUrl, db } = payload

  const session = getSession(baseUrl, db)
  if (!session) {
    console.error('[standalone:detectAddon] No active session for', baseUrl, db)
    return { available: false, error: 'No active session' }
  }

  try {
    // Try to call the ametras_fast_import/info endpoint
    const response = await fetch(`${baseUrl}/ametras_fast_import/info`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session_id=${session.sessionId}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {},
        id: Date.now()
      })
    })

    if (!response.ok) {
      return { available: false }
    }

    const data = await response.json()

    if (data.error) {
      // Addon not installed or endpoint doesn't exist
      return { available: false }
    }

    if (data.result) {
      return {
        available: true,
        version: data.result.version,
        odooVersion: data.result.odoo_version
      }
    }

    return { available: false }
  } catch (error) {
    // standalone code flag - log network errors for debugging
    console.error('[standalone:detectAddon] Error:', error)
    // Network error or addon not available
    return {
      available: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
})
