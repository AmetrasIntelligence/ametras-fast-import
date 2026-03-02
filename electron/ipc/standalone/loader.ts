// standalone code flag (do not remove comment)
/**
 * Direct Odoo model.load() calls for standalone import mode.
 * Bypasses the ametras_fast_import addon by calling /web/dataset/call_kw directly.
 */

import { ipcMain } from 'electron'
import { getSession } from '../odoo'

// Odoo model names: lowercase letters, digits, dots, underscores (e.g. "res.partner")
const ODOO_MODEL_NAME_RE = /^[a-z][a-z0-9_.]*$/

// Request timeout for Odoo RPC calls (60s — load() can be slow for large batches)
const LOAD_TIMEOUT_MS = 60_000

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
  errorCode?: 'NETWORK_ERROR' | 'TIMEOUT' | 'DATA_ERROR' | 'UNKNOWN'
}

// standalone code flag (do not remove comment)
ipcMain.handle('standalone:load', async (
  _event,
  payload: LoadParams
): Promise<LoadResult> => {
  const { baseUrl, db, model, header, rows } = payload

  // Validate model name to prevent injection via crafted model names
  if (!model || !ODOO_MODEL_NAME_RE.test(model)) {
    console.error('[standalone:load] Invalid model name:', model)
    return { ok: false, error: `Invalid model name: ${model}` }
  }

  const session = getSession(baseUrl, db)
  if (!session) {
    console.error('[standalone:load] No active session for', baseUrl, db)
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
      }),
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS)
    })

    if (!response.ok) {
      // standalone code flag - log HTTP errors
      const status = response.status
      console.error('[standalone:load] HTTP error:', status, response.statusText)
      if (status === 502 || status === 503 || status === 504) {
        return { ok: false, error: `HTTP ${status}: Server unavailable`, errorCode: 'NETWORK_ERROR' }
      }
      return { ok: false, error: `HTTP ${status}: ${response.statusText}`, errorCode: 'UNKNOWN' }
    }

    const data = await response.json()

    if (data.error) {
      const errorMsg = data.error.data?.message
        || data.error.message
        || 'Import failed'
      // standalone code flag - log JSON-RPC errors
      console.error('[standalone:load] JSON-RPC error:', errorMsg)
      return { ok: false, error: errorMsg, errorCode: 'DATA_ERROR' }
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
    // standalone code flag - log errors for debugging
    console.error('[standalone:load] Error:', error)
    // Classify the error for network resilience
    let errorCode: 'NETWORK_ERROR' | 'TIMEOUT' | 'UNKNOWN' = 'UNKNOWN'
    if (error instanceof TypeError) {
      errorCode = 'NETWORK_ERROR'
    } else if (error instanceof DOMException && error.name === 'AbortError') {
      errorCode = 'TIMEOUT'
    } else if (error instanceof Error) {
      const msg = error.message.toLowerCase()
      if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
        errorCode = 'TIMEOUT'
      } else if (msg.includes('network') || msg.includes('failed to fetch') || msg.includes('net::')) {
        errorCode = 'NETWORK_ERROR'
      }
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode
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
