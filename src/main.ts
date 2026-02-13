import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import { i18n } from './i18n'
import './assets/main.css'

// Browser fallback for window.api when not running in Electron
if (!window.api) {
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
      getPathForFile: () => {
        console.warn('getPathForFile not available in browser mode')
        return ''
      }
    },
    odoo: {
      call: async (payload) => {
        try {
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
        // In browser mode, try to detect addon via direct fetch
        try {
          const response = await fetch(`${payload.baseUrl}/csv_import/info`, {
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

// Views
import LoginView from './views/LoginView.vue'
import ImportView from './views/ImportView.vue'
import RunView from './views/RunView.vue'
import ResultsView from './views/ResultsView.vue'
import SavedProfilesView from './views/SavedProfilesView.vue'

const routes = [
  { path: '/', redirect: '/login' },
  { path: '/login', component: LoginView },
  { path: '/import', component: ImportView },
  { path: '/profiles', component: SavedProfilesView },
  { path: '/run', component: RunView },
  { path: '/results', component: ResultsView },
  // Backward compatibility redirects
  { path: '/files', redirect: '/import' },
  { path: '/config', redirect: '/import' },
  { path: '/mappings', redirect: '/profiles' }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

const pinia = createPinia()

// Import session store for navigation guard
import { useSessionStore } from './stores/session'

// Navigation guard: redirect to login if not authenticated
router.beforeEach((to, _from, next) => {
  const session = useSessionStore(pinia)

  // Public routes that don't require authentication
  const publicRoutes = ['/login', '/']

  if (publicRoutes.includes(to.path)) {
    // If already authenticated and going to login, redirect to import
    if (session.isAuthenticated && to.path === '/login') {
      next('/import')
    } else {
      next()
    }
  } else {
    // Protected route: check authentication
    if (session.isAuthenticated) {
      next()
    } else {
      next('/login')
    }
  }
})

const app = createApp(App)
app.use(pinia)
app.use(router)
app.use(i18n)
app.mount('#app')
