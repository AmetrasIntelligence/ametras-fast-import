/**
 * Standalone import IPC handlers.
 * Enables CSV import without the ametras_fast_import addon via direct Odoo API calls.
 */

import { ipcMain, net } from 'electron'
import { getOrRefreshSession, isSessionExpiredError, invalidateSession } from './odoo'

// ── Addon detection ──────────────────────────────────────────────────

interface DetectAddonResult {
  available: boolean
  version?: string
  odooVersion?: string
  error?: string
}

ipcMain.handle('standalone:detectAddon', async (
  _event,
  payload: { baseUrl: string; db: string }
): Promise<DetectAddonResult> => {
  const { baseUrl, db } = payload

  const session = await getOrRefreshSession(baseUrl, db)
  if (!session) {
    console.error('[standalone:detectAddon] No active session for', baseUrl, db)
    return { available: false, error: 'No active session' }
  }

  try {
    // Try to call the ametras_fast_import/info endpoint
    const response = await net.fetch(`${baseUrl}/ametras_fast_import/info`, {
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
      }),
      signal: AbortSignal.timeout(10_000) // 10s for addon detection
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
    console.error('[standalone:detectAddon] Error:', error)
    // Network error or addon not available
    return {
      available: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
})

// ── Direct model.load() calls ────────────────────────────────────────

// Odoo model names: lowercase letters, digits, dots, underscores (e.g. "res.partner")
const ODOO_MODEL_NAME_RE = /^[a-z][a-z0-9_.]*$/

// Dynamic request timeout for model.load() calls.
// Formula: clamp(BASE + PER_ROW * rowCount, MIN, MAX)
// model.load() is transactional (heavier per row than addon mode).
const LOAD_TIMEOUT_BASE_MS = 10_000   // 10s base (network round-trip + ORM setup)
const LOAD_TIMEOUT_PER_ROW_MS = 1_000 // 1s per row (transactional load is heavier)
const LOAD_TIMEOUT_MIN_MS = 15_000    // 15s floor (protects slow individual rows)
const LOAD_TIMEOUT_MAX_MS = 120_000   // 120s cap (prevents unbounded waits)
const LOAD_TIMEOUT_ESCALATED_MAX_MS = 600_000 // 10m cap for timeout escalation mode

function computeLoadTimeout(rowCount: number, timeoutOverrideMs?: number): number {
  if (typeof timeoutOverrideMs === 'number' && Number.isFinite(timeoutOverrideMs) && timeoutOverrideMs > 0) {
    return Math.max(LOAD_TIMEOUT_MIN_MS, Math.min(LOAD_TIMEOUT_ESCALATED_MAX_MS, Math.round(timeoutOverrideMs)))
  }
  const raw = LOAD_TIMEOUT_BASE_MS + LOAD_TIMEOUT_PER_ROW_MS * rowCount
  return Math.max(LOAD_TIMEOUT_MIN_MS, Math.min(LOAD_TIMEOUT_MAX_MS, raw))
}

interface LoadParams {
  baseUrl: string
  db: string
  model: string
  header: string[]
  rows: (string | number | boolean | null)[][]
  timeoutMs?: number
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
  errorCode?: 'NETWORK_ERROR' | 'TIMEOUT' | 'DATA_ERROR' | 'CONCURRENCY_ERROR' | 'AUTH_ERROR' | 'UNKNOWN'
}

/** Detect PostgreSQL concurrency/locking errors that are transient and safe to retry. */
function isConcurrencyError(msg: string): boolean {
  const lower = msg.toLowerCase()
  return (
    lower.includes('deadlock detected') ||
    lower.includes('could not serialize access') ||
    lower.includes('could not obtain lock') ||
    lower.includes('lock timeout') ||
    lower.includes('transactionrollbackerror') ||
    lower.includes('serializationfailure')
  )
}

ipcMain.handle('standalone:load', async (
  _event,
  payload: LoadParams
): Promise<LoadResult> => {
  const { baseUrl, db, model, header, rows, timeoutMs } = payload

  // Validate model name to prevent injection via crafted model names
  if (!model || !ODOO_MODEL_NAME_RE.test(model)) {
    console.error('[standalone:load] Invalid model name:', model)
    return { ok: false, error: `Invalid model name: ${model}` }
  }

  const session = await getOrRefreshSession(baseUrl, db)
  if (!session) {
    console.error('[standalone:load] No active session for', baseUrl, db)
    return { ok: false, error: 'No active session', errorCode: 'AUTH_ERROR' }
  }

  try {
    // Call model.load() via the standard Odoo RPC endpoint
    const response = await net.fetch(`${baseUrl}/web/dataset/call_kw`, {
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
      signal: AbortSignal.timeout(computeLoadTimeout(rows.length, timeoutMs))
    })

    if (!response.ok) {
      const status = response.status
      console.error('[standalone:load] HTTP error:', status, response.statusText)
      if (status === 401 || status === 403) {
        invalidateSession(baseUrl, db)
        return { ok: false, error: `HTTP ${status}: Session expired`, errorCode: 'AUTH_ERROR' }
      }
      if (status === 409) {
        return { ok: false, error: `HTTP ${status}: Conflict`, errorCode: 'CONCURRENCY_ERROR' }
      }
      if (status === 429) {
        return { ok: false, error: `HTTP ${status}: Too many requests`, errorCode: 'NETWORK_ERROR' }
      }
      if (status === 500) {
        return {
          ok: false,
          error: `HTTP ${status}: Internal server error (commit state unknown)`,
          // Treat as timeout-like uncertainty so the caller can apply
          // idempotency-safe retry policy instead of blind network retry.
          errorCode: 'TIMEOUT'
        }
      }
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
      console.error('[standalone:load] JSON-RPC error:', errorMsg)
      if (isSessionExpiredError(data.error)) {
        invalidateSession(baseUrl, db)
        return { ok: false, error: errorMsg, errorCode: 'AUTH_ERROR' }
      }
      const errorCode = isConcurrencyError(errorMsg) ? 'CONCURRENCY_ERROR' : 'DATA_ERROR'
      return { ok: false, error: errorMsg, errorCode }
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
    console.error('[standalone:load] Error:', error)
    // Classify the error for network resilience
    let errorCode: 'NETWORK_ERROR' | 'TIMEOUT' | 'UNKNOWN' = 'UNKNOWN'
    if (error instanceof TypeError) {
      errorCode = 'NETWORK_ERROR'
    } else if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
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

// ── Odoo version ─────────────────────────────────────────────────────

// Get Odoo version for compatibility checks
ipcMain.handle('standalone:getOdooVersion', async (
  _event,
  payload: { baseUrl: string; db: string }
): Promise<{ version: string | null; error?: string }> => {
  const { baseUrl, db } = payload

  const session = await getOrRefreshSession(baseUrl, db)
  if (!session) {
    return { version: null, error: 'No active session' }
  }

  // Server version was stored during authentication
  return { version: session.serverVersion || null }
})
