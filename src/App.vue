<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import ErrorBoundary from '@/components/ErrorBoundary.vue'

const session = useSessionStore()
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
            to="/files"
            class="csv-nav__link"
            :class="{ 'csv-nav__link--active': route.path === '/files' }"
          >
            Files
          </router-link>
          <router-link
            to="/config"
            class="csv-nav__link"
            :class="{ 'csv-nav__link--active': route.path === '/config' }"
          >
            Configure
          </router-link>
          <router-link
            to="/mappings"
            class="csv-nav__link"
            :class="{ 'csv-nav__link--active': route.path === '/mappings' }"
          >
            Profiles
          </router-link>
        </div>
        <div class="csv-nav__right">
          <span class="csv-text-xs csv-text-muted">
            {{ session.currentServer?.baseUrl }}
          </span>
          <button type="button" class="csv-nav__logout" @click="logout">
            Logout
          </button>
        </div>
      </nav>
      <RouterView />
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
</style>
