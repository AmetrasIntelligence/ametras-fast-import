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

const routes = [
  { path: '/', redirect: '/login' },
  { path: '/login', component: LoginView },
  { path: '/import', component: ImportView },
  { path: '/profiles', component: SavedProfilesView },
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
import { isPythonAvailable } from './standalone/pythonExecutor'

// Configure platform capabilities
const platform = usePlatformStore(pinia)

// Default: standalone mode (limited features)
platform.configure({
  capabilities: {
    dryRun: false,
    rowValidation: true,
    searchKeys: false,
    serverLogs: false,
    serverProfiles: false,
    lang: false,
  },
  limitations: [
    'Search key upsert not available',
    'Per-row error isolation not available',
    'Explicit operation column (__op__) not supported',
    'Server-side import logs not available',
    'Resume interrupted imports not available',
  ],
})

// Detect Python in background and upgrade capabilities if available
isPythonAvailable().then((available) => {
  if (available) {
    console.warn('[platform] Python import engine detected — enabling full features')
    platform.configure({
      capabilities: {
        dryRun: true,
        rowValidation: true,
        searchKeys: true,
        serverLogs: false,
        serverProfiles: false,
        lang: false,
      },
      limitations: [
        'Server-side import logs not available',
      ],
    })
  } else {
    console.warn('[platform] Python not available — using standalone mode (model.load)')
  }
}).catch(() => {
  // Keep default standalone config
})

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
