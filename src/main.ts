import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
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
      read: async () => '',
      readHead: async () => '',
      countLines: async () => 0,
      streamChunks: async () => {}
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
    }
  }
}

// Views
import LoginView from './views/LoginView.vue'
import FilesView from './views/FilesView.vue'
import ConfigView from './views/ConfigView.vue'
import RunView from './views/RunView.vue'
import ResultsView from './views/ResultsView.vue'
import SavedMappingsView from './views/SavedMappingsView.vue'

const routes = [
  { path: '/', redirect: '/login' },
  { path: '/login', component: LoginView },
  { path: '/files', component: FilesView },
  { path: '/config', component: ConfigView },
  { path: '/run', component: RunView },
  { path: '/results', component: ResultsView },
  { path: '/mappings', component: SavedMappingsView }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
