/**
 * Embedded-mode Vue entry point for Odoo client action.
 * Parallel to main.ts but skips login, uses memory history,
 * and installs the Odoo-backed window.api.
 *
 * Key design: pinia is persistent across mount/unmount cycles so that
 * the import engine (and its promises/timers) keeps running when the
 * user navigates away from the client action in Odoo.
 */
import { createApp, type App } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import AppComponent from './App.vue'
import { i18n, setLocale, type SupportedLocale } from './i18n'
import { useSessionStore } from './stores/session'
import { usePlatformStore } from './stores/platform'
import { useRunStore } from './stores/run'
import { installOdooEmbeddedApi } from './api/odooEmbeddedApi'
import './assets/bootstrap-compat.css'
import './assets/main.css'

// Views
import ImportView from './views/ImportView.vue'
import RunView from './views/RunView.vue'
import ResultsView from './views/ResultsView.vue'
import SavedProfilesView from './views/SavedProfilesView.vue'

let app: App | null = null
let router: Router | null = null

// Pinia is persistent across mount/unmount cycles so the import engine
// and its stores survive when the user navigates away in Odoo.
let persistentPinia: Pinia | null = null

export interface OdooMountOptions {
  uid: number
  baseUrl: string
  db: string
  defaultView?: string
  resumeLogId?: number | null
  logId?: number | null
  profileId?: number | null
  inDialog?: boolean
  closeDialog?: () => void
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
  ]

  router = createRouter({
    history: createMemoryHistory(),
    routes,
  })

  // Reuse pinia across mount/unmount to preserve engine and import state
  const isFirstMount = !persistentPinia
  if (!persistentPinia) {
    persistentPinia = createPinia()
  }
  // setActivePinia ensures useStore() calls from engine code
  // work even between mount/unmount cycles
  setActivePinia(persistentPinia)

  // Set embedded mode BEFORE mounting so onMounted hooks see the session
  const session = useSessionStore(persistentPinia)
  if (isFirstMount) {
    session.setEmbeddedMode({
      uid: options.uid,
      baseUrl: options.baseUrl,
      db: options.db,
    })

    const platform = usePlatformStore(persistentPinia)
    platform.configure({
      capabilities: {
        dryRun: true,
        rowValidation: true,
        searchKeys: true,
        serverLogs: true,
        serverProfiles: true,
        lang: true,
      },
      limitations: [],
    })
  }

  // Sync locale from Odoo's user language (e.g. "de_DE" → "de", "en_US" → "en")
  const odooLang = document.documentElement.getAttribute('lang')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    || (window as any).odoo?.session_info?.user_context?.lang
    || ''
  const langPrefix = odooLang.split(/[-_]/)[0] as SupportedLocale
  if (langPrefix === 'de' || langPrefix === 'en') {
    setLocale(langPrefix)
  }

  app = createApp(AppComponent)
  app.use(persistentPinia)
  app.use(router)
  app.use(i18n)
  app.mount(el)

  // Set dialog mode flag — reset on each mount since it depends on context
  session.setDialogMode(!!options.inDialog)
  session.setCloseDialogCallback(options.closeDialog ?? null)

  // Store resume context if provided
  if (options.resumeLogId) {
    const runStore = useRunStore(persistentPinia)
    runStore.resumeLogId = options.resumeLogId
  }

  // Determine target route
  const runStore = useRunStore(persistentPinia)
  let targetRoute: string

  if (options.logId && options.defaultView === 'results') {
    // Viewing a specific completed/failed log — reset stale data first
    runStore.reset()
    runStore.logId = options.logId
    targetRoute = '/results'
  } else if (options.profileId && options.defaultView === 'profile_detail') {
    // Viewing a specific profile — store ID so SavedProfilesView auto-expands it
    session.setExpandProfileId(options.profileId)
    targetRoute = '/profiles'
  } else if (options.defaultView === 'import') {
    // Explicit request for import view — reset stale run state so we don't
    // get stuck on /results from a previous completed import
    runStore.reset()
    targetRoute = '/import'
  } else if (runStore.isActive) {
    // Import is still running — go straight to the run view
    targetRoute = '/run'
  } else if (runStore.isCompleted) {
    // Import finished while user was away — show results
    targetRoute = '/results'
  } else {
    targetRoute = resolveDefaultView(options.defaultView)
  }

  if (targetRoute !== '/import') {
    router.push(targetRoute)
  }

  return unmountApp
}

function resolveDefaultView(defaultView?: string): string {
  switch (defaultView) {
    case 'profiles':
    case 'profile_detail':
      return '/profiles'
    case 'run':
      return '/run'
    case 'results':
      return '/results'
    case 'import':
    default:
      return '/import'
  }
}

export function unmountApp(): void {
  if (app) {
    app.unmount()
    app = null
    router = null
    // pinia is NOT destroyed — engine and stores stay alive
  }
}
