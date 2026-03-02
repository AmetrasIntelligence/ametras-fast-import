/**
 * Embedded-mode Vue entry point for Odoo client action.
 * Parallel to main.ts but skips login, uses memory history,
 * and installs the Odoo-backed window.api.
 */
import { createApp, type App } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import AppComponent from './App.vue'
import { i18n } from './i18n'
import { useSessionStore } from './stores/session'
import { installOdooEmbeddedApi } from './utils/odooEmbeddedApi'
import './assets/main.css'

// Views
import ImportView from './views/ImportView.vue'
import RunView from './views/RunView.vue'
import ResultsView from './views/ResultsView.vue'
import SavedProfilesView from './views/SavedProfilesView.vue'

let app: App | null = null

export interface OdooMountOptions {
  uid: number
  baseUrl: string
  db: string
}

export function mountApp(el: HTMLElement, options: OdooMountOptions): () => void {
  // Install Odoo-backed API before anything else
  installOdooEmbeddedApi()

  const routes = [
    { path: '/', redirect: '/import' },
    { path: '/import', component: ImportView },
    { path: '/profiles', component: SavedProfilesView },
    { path: '/run', component: RunView },
    { path: '/results', component: ResultsView },
    // Backward compatibility
    { path: '/login', redirect: '/import' },
    { path: '/files', redirect: '/import' },
    { path: '/config', redirect: '/import' },
    { path: '/mappings', redirect: '/profiles' },
  ]

  const router = createRouter({
    history: createMemoryHistory(),
    routes,
  })

  const pinia = createPinia()

  // Set embedded mode BEFORE mounting so onMounted hooks see the session
  const session = useSessionStore(pinia)
  session.setEmbeddedMode({
    uid: options.uid,
    baseUrl: options.baseUrl,
    db: options.db,
  })
  session.importMode = 'addon'

  app = createApp(AppComponent)
  app.use(pinia)
  app.use(router)
  app.use(i18n)
  app.mount(el)

  return unmountApp
}

export function unmountApp(): void {
  if (app) {
    app.unmount()
    app = null
  }
}
