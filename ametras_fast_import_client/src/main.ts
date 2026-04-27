import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from '@/App.vue'
import { i18n } from '@/i18n'
import 'bootstrap/dist/css/bootstrap.min.css'
import '@/assets/main.css'

// Views
import LoginView from './views/LoginView.vue'
import ImportView from '@/views/ImportView.vue'
import RunView from '@/views/RunView.vue'
import ResultsView from '@/views/ResultsView.vue'
import SavedProfilesView from '@/views/SavedProfilesView.vue'
import ProfileWizardView from '@/views/ProfileWizardView.vue'

const routes = [
  { path: '/', redirect: '/login' },
  { path: '/login', component: LoginView },
  { path: '/import', component: ImportView },
  { path: '/profiles', component: SavedProfilesView },
  { path: '/profile-editor', component: ProfileWizardView },
  { path: '/run', component: RunView },
  { path: '/results', component: ResultsView },
  // Backward compat redirects for legacy routes
  { path: '/files', redirect: '/import' },
  { path: '/config', redirect: '/import' },
  { path: '/mappings', redirect: '/profiles' },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

const pinia = createPinia()

// Import session store for navigation guard
import { useSessionStore } from '@/stores/session'
import { usePlatformStore } from '@/stores/platform'
import { useConfigStore } from '@/stores/config'
import {
  executeStandaloneBatch,
  BatchSizeAdapter,
  STANDALONE_MIN_BATCH_SIZE,
  STANDALONE_MAX_BATCH_SIZE,
  STANDALONE_DEFAULT_BATCH_SIZE,
} from './standalone/executor'

// Configure platform for standalone/client mode
const platform = usePlatformStore(pinia)
platform.configure({
  executeBatch: (model, rows, options, context) =>
    executeStandaloneBatch(
      model,
      rows,
      { fieldMappings: options.fieldMappings },
      context.dryRun,
      context.signal,
      context.batchAdapter as BatchSizeAdapter | undefined,
      undefined,
      context.timeoutEscalationLevel ?? 0,
    ),
  maxWorkers: 4,
  batchSizeRange: { min: STANDALONE_MIN_BATCH_SIZE, max: STANDALONE_MAX_BATCH_SIZE },
  createBatchAdapter: (maxBatchSize: number) => new BatchSizeAdapter(maxBatchSize),
  capabilities: {
    dryRun: false,
    rowValidation: false,
    searchKeys: false,
    serverLogs: false,
    serverProfiles: false,
    multipleWorkers: true,
    lang: false,
  },
  limitations: [
    'Search key upsert not available',
    'Per-row error isolation not available',
    'Explicit operation column (__op__) not supported',
    'Dry-run validation not available',
    'Server-side import logs not available',
    'Resume interrupted imports not available',
  ],
})

const config = useConfigStore(pinia)
if (config.settings.workers < 1 || config.settings.workers > platform.maxWorkers) {
  config.setSettings({ workers: Math.max(1, Math.min(platform.maxWorkers, config.settings.workers)) })
}
if (
  config.settings.batchSize < STANDALONE_MIN_BATCH_SIZE ||
  config.settings.batchSize > STANDALONE_MAX_BATCH_SIZE
) {
  config.setSettings({ batchSize: STANDALONE_DEFAULT_BATCH_SIZE })
}

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
