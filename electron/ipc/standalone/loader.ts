// standalone code flag (do not remove comment)
/**
 * Direct Odoo model.load() calls for standalone import mode.
 * Bypasses the csv_import addon by calling /web/dataset/call_kw directly.
 */

import { ipcMain } from 'electron'
import { getSession } from '../odoo'

interface LoadParams {
  baseUrl: string
  db: string
  model: string
  header: string[]
  rows: (string | number | boolean | null)[][]
}

interface LoadResult {
  ok: boolean
  ids?: number[]
  messages?: Array<{
    type: string
    message: string
    record?: number
    field?: string
  }>
  error?: string
}

ipcMain.handle('standalone:load', async (
  _event,
  payload: LoadParams
): Promise<LoadResult> => {
  const { baseUrl, db, model, header, rows } = payload

  const session = getSession(baseUrl, db)
  if (!session) {
    return { ok: false, error: 'No active session' }
  }

  try {
    // Call model.load() via the standard Odoo RPC endpoint
    const response = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session_id=${session.sessionId}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model,
          method: 'load',
          args: [header, rows],
          kwargs: {}
        },
        id: Date.now()
      })
    })

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` }
    }

    const data = await response.json()

    if (data.error) {
      const errorMsg = data.error.data?.message
        || data.error.message
        || 'Import failed'
      return { ok: false, error: errorMsg }
    }

    const result = data.result

    // Odoo's load() returns { ids: [...], messages: [...] }
    if (result.messages && result.messages.length > 0) {
      // Has errors/warnings
      return {
        ok: result.ids && result.ids.length > 0,
        ids: result.ids || [],
        messages: result.messages
      }
    }

    return {
      ok: true,
      ids: result.ids || [],
      messages: []
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
})

// Get Odoo version for compatibility checks
ipcMain.handle('standalone:getOdooVersion', async (
  _event,
  payload: { baseUrl: string; db: string }
): Promise<{ version: string | null; error?: string }> => {
  const { baseUrl, db } = payload

  const session = getSession(baseUrl, db)
  if (!session) {
    return { version: null, error: 'No active session' }
  }

  // Server version was stored during authentication
  return { version: session.serverVersion || null }
})
