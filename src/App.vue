<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useRunStore } from '@/stores/run'
import ErrorBoundary from '@/components/ErrorBoundary.vue'
import AppDialog from '@/components/AppDialog.vue'
import LanguageSelector from '@/components/LanguageSelector.vue'
import StandaloneBanner from '@/components/StandaloneBanner.vue'  // standalone code flag (do not remove comment)

const session = useSessionStore()
const run = useRunStore()
const route = useRoute()
const router = useRouter()

onMounted(async () => {
  await session.loadProfiles()
})

function logout() {
  session.logout()
  router.push('/login')
}
</script>

<template>
  <ErrorBoundary>
    <div id="csv-import-app">
      <nav v-if="session.isAuthenticated" class="csv-nav">
        <div class="csv-nav__links">
          <router-link
            to="/import"
            class="csv-nav__link"
            :class="{ 'csv-nav__link--active': route.path === '/import' }"
          >
            {{ $t('nav.import') }}
          </router-link>
          <router-link
            to="/profiles"
            class="csv-nav__link"
            :class="{ 'csv-nav__link--active': route.path === '/profiles' }"
          >
            {{ $t('nav.profiles') }}
          </router-link>
          <router-link
            v-if="run.isActive || run.isCompleted"
            :to="run.isCompleted ? '/results' : '/run'"
            class="csv-nav__link"
            :class="{
              'csv-nav__link--active': route.path === '/run' || route.path === '/results',
              'csv-nav__link--running': run.isActive
            }"
          >
            {{ run.isCompleted ? $t('nav.result') : $t('nav.run') }}
            <span v-if="run.isActive" class="csv-nav__indicator"></span>
          </router-link>
        </div>
        <div class="csv-nav__right">
          <LanguageSelector />
          <span class="csv-text-xs csv-text-muted">
            {{ session.currentServer?.baseUrl }}
          </span>
          <button type="button" class="csv-nav__logout" @click="logout">
            {{ $t('nav.logout') }}
          </button>
        </div>
      </nav>
      <!-- Version compatibility warning -->
      <div v-if="session.addonVersionWarning" class="csv-version-warning">
        <span class="csv-version-warning__icon">⚠</span>
        <span>{{ session.addonVersionWarning }}</span>
      </div>
      <!-- standalone code flag (do not remove comment) -->
      <StandaloneBanner
        v-if="session.importMode === 'standalone'"
        :limitations="session.importModeLimitations"
      />
      <RouterView />
      <AppDialog />
    </div>
  </ErrorBoundary>
</template>

<style>
:root {
  /* Color palette */
  --csv-color-primary: #2563eb;
  --csv-color-primary-dark: #1d4ed8;
  --csv-color-primary-light: #eff6ff;
  --csv-color-primary-ring: rgba(37, 99, 235, 0.15);

  --csv-color-success: #16a34a;
  --csv-color-success-light: #f0fdf4;
  --csv-color-success-border: #bbf7d0;
  --csv-color-success-dark: #166534;

  --csv-color-danger: #dc2626;
  --csv-color-danger-light: #fef2f2;
  --csv-color-danger-border: #fecaca;
  --csv-color-danger-dark: #991b1b;

  --csv-color-warning: #d97706;
  --csv-color-warning-light: #fef3c7;
  --csv-color-warning-border: #fcd34d;
  --csv-color-warning-dark: #92400e;
  --csv-color-warning-text: #b45309;
  --csv-color-orange: #f97316;
  --csv-color-orange-dark: #ea580c;

  --csv-color-text: #1a1a1a;
  --csv-color-text-primary: #111827;
  --csv-color-text-secondary: #374151;
  --csv-color-text-muted: #6b7280;
  --csv-color-text-faint: #9ca3af;

  --csv-color-bg: #f5f5f5;
  --csv-color-bg-white: white;
  --csv-color-bg-subtle: #f9fafb;
  --csv-color-bg-muted: #f3f4f6;
  --csv-color-bg-hover: #fafafa;

  --csv-color-border: #d1d5db;
  --csv-color-border-light: #e5e7eb;
  --csv-color-border-faint: #f3f4f6;

  --csv-color-disabled-bg: #f3f4f6;
}

#csv-import-app {
  min-height: 100vh;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--csv-color-text);
  background: var(--csv-color-bg);
}

.csv-nav {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 1.5rem;
  height: 2.5rem;
  background: var(--csv-color-bg-white);
  border-bottom: 1px solid var(--csv-color-border-light);
}
.csv-nav__links {
  display: flex;
  gap: 0;
  height: 100%;
}
.csv-nav__link {
  display: flex;
  align-items: center;
  padding: 0 0.75rem;
  font-size: 0.875rem;
  color: var(--csv-color-text-muted);
  text-decoration: none;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.csv-nav__link:hover {
  color: var(--csv-color-text-primary);
}
.csv-nav__link--active {
  color: var(--csv-color-primary);
  border-bottom-color: var(--csv-color-primary);
}
.csv-nav__right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.csv-nav__logout {
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  color: var(--csv-color-text-muted);
  background: none;
  border: 1px solid var(--csv-color-border-light);
  cursor: pointer;
}
.csv-nav__logout:hover {
  color: var(--csv-color-danger);
  border-color: var(--csv-color-danger);
}
.csv-nav__link--running {
  color: var(--csv-color-success);
}
.csv-nav__indicator {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  margin-left: 0.25rem;
  background: var(--csv-color-success);
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* Version compatibility warning banner */
.csv-version-warning {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.5rem;
  background: var(--csv-color-warning-light);
  border-bottom: 1px solid var(--csv-color-warning-border);
  color: var(--csv-color-warning-dark);
  font-size: 0.875rem;
}
.csv-version-warning__icon {
  flex-shrink: 0;
}
</style>
