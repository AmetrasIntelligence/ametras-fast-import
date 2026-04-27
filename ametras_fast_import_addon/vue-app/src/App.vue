<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useFilesStore } from '@/stores/files'
import { useConfigStore } from '@/stores/config'
import { useRunStore } from '@/stores/run'
import ErrorBoundary from '@/components/ErrorBoundary.vue'
import AppDialog from '@/components/AppDialog.vue'
import LanguageSelector from '@/components/LanguageSelector.vue'

import { Button } from '@/ui'

const session = useSessionStore()
const filesStore = useFilesStore()
const configStore = useConfigStore()
const run = useRunStore()
const route = useRoute()
const router = useRouter()

const appVersion = __APP_VERSION__

onMounted(async () => {
  await session.loadProfiles()
})

function logout() {
  // run.reset() aborts the engine silently and clears all state.
  run.reset()
  filesStore.clearAll()
  configStore.reset()
  session.logout()
  router.push('/login')
}
</script>

<template>
  <ErrorBoundary>
    <div id="csv-import-app">
      <nav v-if="session.isAuthenticated && !session.isEmbedded" class="csv-nav navbar navbar-expand bg-white border-bottom sticky-top px-4" style="z-index: 100;">
        <ul class="navbar-nav me-auto">
          <li class="nav-item">
            <router-link
              to="/import"
              class="nav-link"
              :class="{ 'active fw-semibold': route?.path === '/import' }"
            >
              {{ $t('nav.import') }}
            </router-link>
          </li>
          <li class="nav-item">
            <router-link
              to="/profiles"
              class="nav-link"
              :class="{ 'active fw-semibold': route?.path === '/profiles' }"
            >
              {{ $t('nav.profiles') }}
            </router-link>
          </li>
          <li class="nav-item">
            <router-link
              to="/profile-editor"
              class="nav-link"
              :class="{ 'active fw-semibold': route?.path === '/profile-editor' }"
            >
              {{ $t('nav.profileEditor') }}
            </router-link>
          </li>
          <li v-if="run.isActive || run.isCompleted" class="nav-item">
            <router-link
              :to="run.isCompleted ? '/results' : '/run'"
              class="nav-link"
              :class="{
                'active fw-semibold': route?.path === '/run' || route?.path === '/results',
                'text-success': run.isActive
              }"
            >
              {{ run.isCompleted ? $t('nav.result') : $t('nav.run') }}
              <span v-if="run.isActive" class="csv-nav__indicator"></span>
            </router-link>
          </li>
        </ul>
        <div class="d-flex align-items-center gap-3">
          <LanguageSelector v-if="!session.isEmbedded" />
          <template v-if="!session.isEmbedded">
            <small class="text-body-secondary">
              {{ session.currentServer?.baseUrl }}
            </small>
            <small v-if="appVersion" class="csv-nav__version">v{{ appVersion }}</small>
            <Button variant="outline" size="sm" class="csv-nav__logout" @click="logout">
              {{ $t('nav.logout') }}
            </Button>
          </template>
        </div>
      </nav>
      <RouterView />
      <AppDialog />
    </div>
  </ErrorBoundary>
</template>

<style>
#csv-import-app {
  min-height: 100vh;
  font-size: 14px;
  line-height: 1.5;
}

/* When embedded inside Odoo's container, don't force 100vh */
.o_csv_import_vue_app #csv-import-app {
  min-height: 100%;
}

/* When inside an Odoo dialog, constrain height and allow scrolling */
.o_dialog .o_csv_import_vue_app #csv-import-app {
  min-height: auto;
  max-height: 80vh;
  overflow-y: auto;
}

.csv-nav__version {
  color: var(--bs-secondary-color);
  font-size: 0.675rem;
  opacity: 0.6;
}

.csv-nav__logout {
  font-size: 0.75rem;
  padding-top: 0;
  padding-bottom: 0;
}

.csv-nav__indicator {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  margin-left: 0.25rem;
  background: var(--bs-success);
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
