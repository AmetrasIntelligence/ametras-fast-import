import { ipcMain } from 'electron'

interface OdooSession {
  baseUrl: string
  db: string
  uid: number
  sessionId: string
  serverVersion: string
  lastActivity: number  // Timestamp of last activity
  createdAt: number     // Timestamp of creation
}

// Session TTL: 30 minutes of inactivity
const SESSION_TTL_MS = 30 * 60 * 1000
// Maximum session age: 8 hours
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000
// Cleanup interval: 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

// Request timeouts for Odoo RPC calls
const RPC_TIMEOUT_MS = 30_000       // 30s for general RPC calls
const AUTH_TIMEOUT_MS = 15_000      // 15s for authentication
const DB_LIST_TIMEOUT_MS = 10_000   // 10s for database listing
const HEALTH_CHECK_TIMEOUT_MS = 5_000 // 5s for server ping (health check)

const sessions = new Map<string, OdooSession>()

/**
 * Clean up expired sessions.
 * Removes sessions that:
 * - Have been inactive for longer than SESSION_TTL_MS
 * - Are older than SESSION_MAX_AGE_MS
 */
function cleanupExpiredSessions(): void {
  const now = Date.now()
  const expiredKeys: string[] = []

  for (const [key, session] of sessions) {
    const inactiveTime = now - session.lastActivity
    const sessionAge = now - session.createdAt

    if (inactiveTime > SESSION_TTL_MS || sessionAge > SESSION_MAX_AGE_MS) {
      expiredKeys.push(key)
    }
  }

  for (const key of expiredKeys) {
    sessions.delete(key)
  }

  if (expiredKeys.length > 0) {
    console.log(`[session] Cleaned up ${expiredKeys.length} expired session(s)`)
  }
}

/**
 * Update session activity timestamp.
 */
function touchSession(session: OdooSession): void {
  session.lastActivity = Date.now()
}

/**
 * Check if session is still valid (not expired).
 */
function isSessionValid(session: OdooSession): boolean {
  const now = Date.now()
  const inactiveTime = now - session.lastActivity
  const sessionAge = now - session.createdAt

  return inactiveTime <= SESSION_TTL_MS && sessionAge <= SESSION_MAX_AGE_MS
}

// Start periodic cleanup
let cleanupInterval: NodeJS.Timeout | null = null

function startSessionCleanup(): void {
  if (cleanupInterval) return
  cleanupInterval = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS)
  // Don't prevent app from exiting
  cleanupInterval.unref()
}

function stopSessionCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
}

// Start cleanup on module load
startSessionCleanup()

/**
 * Validate URL is a proper HTTP(S) URL to prevent SSRF and injection attacks.
 */
function validateBaseUrl(baseUrl: string): { valid: boolean; error?: string } {
  try {
    const url = new URL(baseUrl)

    // Only allow HTTP(S) protocols
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' }
    }

    // Prevent localhost/internal network access in production (optional - remove if needed for dev)
    // const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.startsWith('192.168.')
    // if (isLocal && process.env.NODE_ENV === 'production') {
    //   return { valid: false, error: 'Local network access not allowed' }
    // }

    return { valid: true }
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }
}

/**
 * Validate endpoint is a relative path, not an absolute URL.
 */
function validateEndpoint(endpoint: string): { valid: boolean; error?: string } {
  // Endpoint must start with / and not contain protocol
  if (!endpoint.startsWith('/')) {
    return { valid: false, error: 'Endpoint must start with /' }
  }
  if (endpoint.includes('://')) {
    return { valid: false, error: 'Endpoint must be a relative path' }
  }
  return { valid: true }
}

function getSessionKey(baseUrl: string, db: string): string {
  return `${baseUrl}::${db}`
}

// Fetch available databases from Odoo server
ipcMain.handle('odoo:listDatabases', async (_event, baseUrl: string) => {
  const urlCheck = validateBaseUrl(baseUrl)
  if (!urlCheck.valid) {
    return { ok: false, databases: [], error: urlCheck.error }
  }

  try {
    const response = await fetch(`${baseUrl}/web/database/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {},
        id: Date.now()
      }),
      signal: AbortSignal.timeout(DB_LIST_TIMEOUT_MS)
    })

    const data = await response.json()

    if (data.error) {
      // Database list might be disabled for security
      return { ok: false, databases: [], error: 'Database listing disabled' }
    }

    return { ok: true, databases: data.result || [] }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to fetch databases'
    return { ok: false, databases: [], error: message }
  }
})

ipcMain.handle('odoo:authenticate', async (_event, params: {
  baseUrl: string
  db: string
  login: string
  password: string
}) => {
  const urlCheck = validateBaseUrl(params.baseUrl)
  if (!urlCheck.valid) {
    return { ok: false, error: urlCheck.error }
  }

  try {
    const { baseUrl, db, login, password } = params

    const response = await fetch(`${baseUrl}/web/session/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { db, login, password },
        id: Date.now()
      }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS)
    })

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` }
    }

    const data = await response.json()

    if (data.error) {
      return { ok: false, error: data.error.data?.message || 'Authentication failed' }
    }

    const result = data.result
    if (!result.uid) {
      return { ok: false, error: 'Invalid credentials' }
    }

    const cookies = response.headers.get('set-cookie')
    const sessionMatch = cookies?.match(/session_id=([^;]+)/)
    const sessionId = sessionMatch?.[1] || ''

    const now = Date.now()
    const session: OdooSession = {
      baseUrl,
      db,
      uid: result.uid,
      sessionId,
      serverVersion: result.server_version,
      lastActivity: now,
      createdAt: now
    }

    sessions.set(getSessionKey(baseUrl, db), session)

    return {
      ok: true,
      uid: result.uid,
      session_id: sessionId,
      server_version: result.server_version
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Connection failed'
    return { ok: false, error: message }
  }
})

ipcMain.handle('odoo:call', async (_event, payload: {
  baseUrl: string
  db?: string
  endpoint: string
  params: Record<string, unknown>
}) => {
  const urlCheck = validateBaseUrl(payload.baseUrl)
  if (!urlCheck.valid) {
    return { ok: false, error: urlCheck.error }
  }

  const endpointCheck = validateEndpoint(payload.endpoint)
  if (!endpointCheck.valid) {
    return { ok: false, error: endpointCheck.error }
  }

  try {
    const { baseUrl, endpoint, params } = payload

    let session = payload.db
      ? sessions.get(getSessionKey(baseUrl, payload.db))
      : undefined
    if (!session) {
      // Fallback: find any session for this baseUrl
      const candidates = Array.from(sessions.values()).filter(s => s.baseUrl === baseUrl)
      if (candidates.length > 1) {
        console.warn(
          `[odoo:call] Ambiguous session fallback: ${candidates.length} sessions for ${baseUrl} ` +
          `(dbs: ${candidates.map(s => s.db).join(', ')}). Pass 'db' parameter to avoid wrong-database auth.`
        )
      }
      session = candidates[0]
    }

    if (!session) {
      return { ok: false, error: 'Not authenticated' }
    }

    // Check if session is expired
    if (!isSessionValid(session)) {
      const key = getSessionKey(session.baseUrl, session.db)
      sessions.delete(key)
      return { ok: false, error: 'Session expired - please login again' }
    }

    // Update activity timestamp
    touchSession(session)

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session_id=${session.sessionId}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params,
        id: Date.now()
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
    })

    // Check HTTP-level errors before parsing JSON
    if (!response.ok) {
      const status = response.status
      if (status === 502 || status === 503 || status === 504) {
        return { ok: false, error: `HTTP ${status}: Server unavailable`, errorCode: 'NETWORK_ERROR' }
      }
      return { ok: false, error: `HTTP ${status}: ${response.statusText}`, errorCode: 'UNKNOWN' }
    }

    const data = await response.json()

    if (data.error) {
      return {
        ok: false,
        error: data.error.data?.message || data.error.message || 'RPC Error',
        errorCode: 'DATA_ERROR'
      }
    }

    return { ok: true, result: data.result }
  } catch (e) {
    // Classify the error for network resilience
    let errorCode: 'NETWORK_ERROR' | 'TIMEOUT' | 'UNKNOWN' = 'UNKNOWN'
    if (e instanceof TypeError) {
      // TypeError from fetch = DNS failure, connection refused, offline
      errorCode = 'NETWORK_ERROR'
    } else if (e instanceof DOMException && e.name === 'AbortError') {
      errorCode = 'TIMEOUT'
    } else if (e instanceof Error) {
      const msg = e.message.toLowerCase()
      if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
        errorCode = 'TIMEOUT'
      } else if (msg.includes('network') || msg.includes('failed to fetch') || msg.includes('net::')) {
        errorCode = 'NETWORK_ERROR'
      }
    }
    const message = e instanceof Error ? e.message : 'Request failed'
    return { ok: false, error: message, errorCode }
  }
})

// Lightweight server reachability check — no session validation.
// Used by the health check during reconnection so that expired sessions
// don't prevent detection of a recovered server.
ipcMain.handle('odoo:ping', async (_event, baseUrl: string) => {
  const urlCheck = validateBaseUrl(baseUrl)
  if (!urlCheck.valid) {
    return { ok: false, error: urlCheck.error }
  }

  try {
    const response = await fetch(`${baseUrl}/web/webclient/version_info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {},
        id: Date.now()
      }),
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
    })
    return { ok: response.ok }
  } catch {
    return { ok: false }
  }
})

export function getSession(baseUrl: string, db?: string): OdooSession | undefined {
  let session: OdooSession | undefined
  if (db) {
    session = sessions.get(getSessionKey(baseUrl, db))
  } else {
    // Fallback: find any session for this baseUrl, warn if ambiguous
    const candidates = Array.from(sessions.values()).filter(s => s.baseUrl === baseUrl)
    if (candidates.length > 1) {
      console.warn(
        `[session] Ambiguous session lookup: ${candidates.length} sessions for ${baseUrl} ` +
        `(dbs: ${candidates.map(s => s.db).join(', ')}). Pass 'db' to avoid wrong-database auth.`
      )
    }
    session = candidates[0]
  }

  // Return only if session is still valid
  if (session && isSessionValid(session)) {
    touchSession(session)
    return session
  }

  // Remove expired session
  if (session) {
    sessions.delete(getSessionKey(session.baseUrl, session.db))
  }

  return undefined
}

export function clearSessions(): void {
  sessions.clear()
}

/**
 * Cleanup on app quit - clear all sessions and stop interval.
 */
export function shutdownSessions(): void {
  stopSessionCleanup()
  sessions.clear()
}
