import { ipcMain } from 'electron'

interface OdooSession {
  baseUrl: string
  db: string
  uid: number
  sessionId: string
  serverVersion: string
}

const sessions = new Map<string, OdooSession>()

function getSessionKey(baseUrl: string, db: string): string {
  return `${baseUrl}::${db}`
}

// Fetch available databases from Odoo server
ipcMain.handle('odoo:listDatabases', async (_event, baseUrl: string) => {
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
