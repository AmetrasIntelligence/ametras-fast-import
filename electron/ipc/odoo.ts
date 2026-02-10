import { ipcMain } from 'electron'

interface OdooSession {
  baseUrl: string
  db: string
  uid: number
  sessionId: string
  serverVersion: string
}

const sessions = new Map<string, OdooSession>()

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
      })
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
      })
    })

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

    const session: OdooSession = {
      baseUrl,
      db,
      uid: result.uid,
      sessionId,
      serverVersion: result.server_version
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

    const session = Array.from(sessions.values())
      .find(s => s.baseUrl === baseUrl)

    if (!session) {
      return { ok: false, error: 'Not authenticated' }
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
      })
    })

    const data = await response.json()

    if (data.error) {
      return { ok: false, error: data.error.data?.message || data.error.message || 'RPC Error' }
    }

    return { ok: true, result: data.result }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Request failed'
    return { ok: false, error: message }
  }
})

export function getSession(baseUrl: string): OdooSession | undefined {
  return Array.from(sessions.values()).find(s => s.baseUrl === baseUrl)
}

export function clearSessions() {
  sessions.clear()
}
