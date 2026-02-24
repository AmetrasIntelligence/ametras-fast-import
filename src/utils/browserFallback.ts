/**
 * Browser fallback for window.api when not running in Electron.
 * Provides stub implementations using fetch/localStorage so the app
 * can run in a plain browser for development and light usage.
 */

/** Warn if baseUrl is not HTTPS — credentials sent via plain HTTP can be intercepted. */
function warnIfInsecure(baseUrl: string): void {
  try {
    const url = new URL(baseUrl)
    if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      console.warn(
        `[browser-fallback] WARNING: Sending credentials over insecure HTTP to ${url.hostname}. ` +
        `Use HTTPS in production to prevent credential interception.`
      )
    }
  } catch { /* invalid URL — will fail at fetch */ }
}

export function installBrowserFallback(): void {
  if (window.api) return

  const browserStore: Record<string, unknown> = JSON.parse(localStorage.getItem('csv-import-store') || '{}')

  window.api = {
    files: {
      select: async () => {
        console.warn('File selection not available in browser mode')
        return []
      },
      register: async () => {
        console.warn('File registration not available in browser mode')
        return []
      },
      read: async () => '',
      readHead: async () => '',
      countLines: async () => 0,
      streamChunks: async () => {},
      streamStart: async () => {
        console.warn('File streaming not available in browser mode')
        return ''
      },
      streamNext: async () => ({ data: '', done: true }),
      streamClose: async () => {},
      getPathForFile: () => {
        console.warn('getPathForFile not available in browser mode')
        return ''
      }
    },
    odoo: {
      call: async (payload) => {
        try {
          warnIfInsecure(payload.baseUrl)
          const response = await fetch(`${payload.baseUrl}${payload.endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'call',
              params: payload.params,
              id: Date.now()
            })
          })
          const data = await response.json()
          if (data.error) {
            return { ok: false, error: data.error.data?.message || data.error.message || 'RPC Error' }
          }
          return { ok: true, result: data.result }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : 'Request failed' }
        }
      },
      authenticate: async (params) => {
        try {
          warnIfInsecure(params.baseUrl)
          const response = await fetch(`${params.baseUrl}/web/session/authenticate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'call',
              params: { db: params.db, login: params.login, password: params.password },
              id: Date.now()
            })
          })
          const data = await response.json()
          if (data.error) {
            return { ok: false, error: data.error.data?.message || 'Authentication failed' }
          }
          if (!data.result?.uid) {
            return { ok: false, error: 'Invalid credentials' }
          }
          return {
            ok: true,
            uid: data.result.uid,
            session_id: '',
            server_version: data.result.server_version
          }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : 'Connection failed' }
        }
      },
      listDatabases: async (baseUrl) => {
        try {
          const response = await fetch(`${baseUrl}/web/database/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {}, id: Date.now() })
          })
          const data = await response.json()
          if (data.error) {
            return { ok: false, databases: [], error: 'Database listing disabled' }
          }
          return { ok: true, databases: data.result || [] }
        } catch (e) {
          return { ok: false, databases: [], error: e instanceof Error ? e.message : 'Failed' }
        }
      }
    },
    store: {
      get: async (key) => browserStore[key] ?? null,
      set: async (key, value) => {
        browserStore[key] = value
        localStorage.setItem('csv-import-store', JSON.stringify(browserStore))
      }
    },
    profile: {
      selectZip: async () => {
        console.warn('Profile ZIP selection not available in browser mode')
        return null
      },
      upload: async () => ({ ok: false, error: 'Not available in browser mode' }),
      export: async () => {
        console.warn('Profile export not available in browser mode')
        return false
      }
    },
    // standalone code flag (do not remove comment)
    standalone: {
      detectAddon: async (payload) => {
        try {
          const response = await fetch(`${payload.baseUrl}/ametras_fast_import/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {}, id: Date.now() })
          })
          const data = await response.json()
          if (data.error) {
            return { available: false }
          }
          return {
            available: true,
            version: data.result?.version,
            odooVersion: data.result?.odoo_version
          }
        } catch {
          return { available: false }
        }
      },
      load: async (payload) => {
        try {
          const response = await fetch(`${payload.baseUrl}/web/dataset/call_kw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'call',
              params: {
                model: payload.model,
                method: 'load',
                args: [payload.header, payload.rows],
                kwargs: {}
              },
              id: Date.now()
            })
          })
          const data = await response.json()
          if (data.error) {
            return { ok: false, error: data.error.data?.message || 'Import failed' }
          }
          return {
            ok: true,
            ids: data.result?.ids || [],
            messages: data.result?.messages || []
          }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : 'Request failed' }
        }
      },
      getOdooVersion: async () => ({ version: null })
    }
  }
}
