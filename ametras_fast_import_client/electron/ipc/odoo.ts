import { ipcMain, safeStorage } from 'electron'
import { getStoreValue } from './store'

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
const savedCredentials = new Map<string, {
  baseUrl: string; db: string; login: string;
  password: Buffer;
  encrypted: boolean;
}>()
const reauthInProgress = new Map<string, Promise<OdooSession | undefined>>()
const reauthFailures = new Map<string, { count: number; lastAttempt: number }>()

// Re-auth rate limiting: after 3 consecutive failures, cool down for 5 minutes
// to avoid hammering the server (e.g. password was changed during an outage).
const REAUTH_MAX_FAILURES = 3
const REAUTH_COOLDOWN_MS = 5 * 60 * 1000

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

/**
 * Detect Odoo server-side session expiry from a JSON-RPC error payload.
 * Odoo returns HTTP 200 with a JSON-RPC error when the session has expired
 * (e.g. server-side GC), which is different from a client-side TTL expiry.
 */
export function isSessionExpiredError(
  error: { code?: number; data?: { name?: string; message?: string }; message?: string }
): boolean {
  const name = (error.data?.name || '').toLowerCase()
  const message = (error.data?.message || error.message || '').toLowerCase()
  return (
    name.includes('sessionexpiredexception') ||
    message.includes('session expired') ||
    message.includes('session invalid')
  )
}

/**
 * Remove a session from the in-memory store so that the next
 * getOrRefreshSession() call triggers re-authentication.
 */
export function invalidateSession(baseUrl: string, db?: string): void {
  if (db) {
    sessions.delete(getSessionKey(baseUrl, db))
  } else {
    for (const [key, session] of sessions) {
      if (session.baseUrl === baseUrl) {
        sessions.delete(key)
      }
    }
  }
}

/**
 * Touch all sessions for a given base URL.
 * Used by health checks to prevent session expiry during server outages.
 */
function touchSessionsForBaseUrl(baseUrl: string): void {
  for (const session of sessions.values()) {
    if (session.baseUrl === baseUrl) {
      touchSession(session)
    }
  }
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

/**
 * Core authentication logic shared by initial login and re-authentication.
 * May throw on network errors — callers should handle exceptions.
 */
async function performAuthentication(
  baseUrl: string,
  db: string,
  login: string,
  password: string
): Promise<{ ok: boolean; uid?: number; session_id?: string; server_version?: string; error?: string }> {
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
}

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
    const result = await performAuthentication(params.baseUrl, params.db, params.login, params.password)

    if (result.ok) {
      // Clear any reauth rate-limit so the session is immediately usable.
      // Without this, zombie timeouts from a skipped file can lock out all
      // calls for 5 minutes even after a successful explicit re-login.
      reauthFailures.delete(getSessionKey(params.baseUrl, params.db))

      // Save credentials for automatic re-authentication after session expiry.
      // Decouple from IPC response so that a macOS Keychain dialog (triggered
      // by the first safeStorage.encryptString call) never blocks the login.
      const pref = getStoreValue('credentialEncryption') as string | null
      if (pref === 'enabled' || pref === 'disabled') {
        const { baseUrl, db, login, password } = params
        setTimeout(() => {
          const useEncryption = pref === 'enabled' && safeStorage.isEncryptionAvailable()
          savedCredentials.set(getSessionKey(baseUrl, db), {
            baseUrl, db, login,
            password: useEncryption
              ? safeStorage.encryptString(password)
              : Buffer.from(password),
            encrypted: useEncryption
          })
        }, 0)
      }
    }

    return result
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

    const session = await getOrRefreshSession(baseUrl, payload.db)
    if (!session) {
      return { ok: false, error: 'Not authenticated', errorCode: 'AUTH_ERROR' }
    }

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
      if (status === 401 || status === 403) {
        invalidateSession(baseUrl, payload.db)
        return { ok: false, error: `HTTP ${status}: Session expired`, errorCode: 'AUTH_ERROR' }
      }
      if (status === 429) {
        return { ok: false, error: `HTTP ${status}: Too many requests`, errorCode: 'NETWORK_ERROR' }
      }
      if (status === 500) {
        return { ok: false, error: `HTTP ${status}: Internal server error`, errorCode: 'NETWORK_ERROR' }
      }
      if (status === 502 || status === 503 || status === 504) {
        return { ok: false, error: `HTTP ${status}: Server unavailable`, errorCode: 'NETWORK_ERROR' }
      }
      return { ok: false, error: `HTTP ${status}: ${response.statusText}`, errorCode: 'UNKNOWN' }
    }

    const data = await response.json()

    if (data.error) {
      const errorMsg = data.error.data?.message || data.error.message || 'RPC Error'
      if (isSessionExpiredError(data.error)) {
        invalidateSession(baseUrl, payload.db)
        return { ok: false, error: errorMsg, errorCode: 'AUTH_ERROR' }
      }
      return { ok: false, error: errorMsg, errorCode: 'DATA_ERROR' }
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
    if (response.ok) {
      touchSessionsForBaseUrl(baseUrl)
    }
    return { ok: response.ok }
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('odoo:getEncryptionInfo', () => ({
  available: safeStorage.isEncryptionAvailable(),
  platform: process.platform
}))

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

/**
 * Get an existing valid session, or attempt re-authentication using saved credentials.
 * Returns undefined only when no credentials are available or re-auth fails.
 */
export async function getOrRefreshSession(baseUrl: string, db?: string): Promise<OdooSession | undefined> {
  // Try existing valid session first
  const existing = getSession(baseUrl, db)
  if (existing) return existing

  // Look up saved credentials
  let creds: { baseUrl: string; db: string; login: string; password: Buffer; encrypted: boolean } | undefined
  if (db) {
    creds = savedCredentials.get(getSessionKey(baseUrl, db))
  } else {
    // Fallback: find any credentials for this baseUrl
    const candidates = Array.from(savedCredentials.values()).filter(c => c.baseUrl === baseUrl)
    creds = candidates[0]
  }

  if (!creds) return undefined

  const key = getSessionKey(creds.baseUrl, creds.db)

  // Rate-limit re-auth: back off after repeated failures to avoid
  // hammering the server (e.g. password changed during an outage).
  const failures = reauthFailures.get(key)
  if (failures && failures.count >= REAUTH_MAX_FAILURES) {
    const elapsed = Date.now() - failures.lastAttempt
    if (elapsed < REAUTH_COOLDOWN_MS) {
      return undefined
    }
    // Cooldown expired — allow another attempt
    reauthFailures.delete(key)
  }

  // Deduplicate concurrent re-auth attempts for the same session
  const inProgress = reauthInProgress.get(key)
  if (inProgress) return inProgress

  const { baseUrl: credBaseUrl, db: credDb, login, password: credPassword, encrypted } = creds
  const promise = (async (): Promise<OdooSession | undefined> => {
    try {
      console.log(`[session] Re-authenticating for ${credBaseUrl} (db: ${credDb})`)
      const password = encrypted
        ? safeStorage.decryptString(credPassword)
        : credPassword.toString('utf-8')
      const result = await performAuthentication(credBaseUrl, credDb, login, password)
      if (result.ok) {
        reauthFailures.delete(key)
        return sessions.get(key)
      }
      console.error(`[session] Re-authentication failed: ${result.error}`)
      const prev = reauthFailures.get(key)
      reauthFailures.set(key, { count: (prev?.count ?? 0) + 1, lastAttempt: Date.now() })
      return undefined
    } catch (e) {
      console.error('[session] Re-authentication error:', e)
      const prev = reauthFailures.get(key)
      reauthFailures.set(key, { count: (prev?.count ?? 0) + 1, lastAttempt: Date.now() })
      return undefined
    } finally {
      reauthInProgress.delete(key)
    }
  })()

  reauthInProgress.set(key, promise)
  return promise
}

export function clearSessions(): void {
  sessions.clear()
  savedCredentials.clear()
  reauthFailures.clear()
}

/**
 * Cleanup on app quit - clear all sessions and stop interval.
 */
export function shutdownSessions(): void {
  stopSessionCleanup()
  sessions.clear()
  savedCredentials.clear()
  reauthInProgress.clear()
  reauthFailures.clear()
}
