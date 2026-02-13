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
            to="/run"
            class="csv-nav__link"
            :class="{
              'csv-nav__link--active': route.path === '/run',
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
#csv-import-app {
  min-height: 100vh;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #1a1a1a;
  background: #f5f5f5;
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
  background: white;
  border-bottom: 1px solid #e5e7eb;
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
  color: #6b7280;
  text-decoration: none;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.csv-nav__link:hover {
  color: #111827;
}
.csv-nav__link--active {
  color: #2563eb;
  border-bottom-color: #2563eb;
}
.csv-nav__right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.csv-nav__logout {
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  color: #6b7280;
  background: none;
  border: 1px solid #e5e7eb;
  cursor: pointer;
}
.csv-nav__logout:hover {
  color: #dc2626;
  border-color: #dc2626;
}
.csv-nav__link--running {
  color: #16a34a;
}
.csv-nav__indicator {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  margin-left: 0.25rem;
  background: #16a34a;
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
  background: #fef3c7;
  border-bottom: 1px solid #fcd34d;
  color: #92400e;
  font-size: 0.875rem;
}
.csv-version-warning__icon {
  flex-shrink: 0;
}
</style>
