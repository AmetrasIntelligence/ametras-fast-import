<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '@/stores/session'
import { Button, Input, Card, Divider } from '@/ui'

const { t } = useI18n()

const router = useRouter()
const session = useSessionStore()

const host = ref('')
const port = ref('')
const useSSL = ref(true)
const db = ref('')
const login = ref('')
const password = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const showAdvanced = ref(false)
const selectedProfileId = ref('')

const savedProfiles = computed(() => session.savedProfiles)

onMounted(async () => {
  if (session.isAuthenticated) {
    router.push('/import')
    return
  }
  await session.loadProfiles()
})

// Build URL from components
function buildUrl(): string {
  let url = host.value.trim()

  // Remove any existing protocol
  url = url.replace(/^https?:\/\//i, '')

  // Remove trailing slash
  url = url.replace(/\/+$/, '')

  // Remove port if present in host (we'll add it from port field)
  url = url.replace(/:\d+$/, '')

  // Add protocol
  const protocol = useSSL.value ? 'https://' : 'http://'
  url = protocol + url

  // Add port if specified
  if (port.value) {
    url += ':' + port.value
  }

  return url
}

// Parse URL into components (for loading saved profiles)
function parseUrl(url: string) {
  const match = url.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/)
  if (match) {
    useSSL.value = match[1] === 'https'
    host.value = match[2]
    port.value = match[3] || ''
  } else {
    host.value = url
  }
}

async function handleLogin() {
  loading.value = true
  error.value = null

  const finalUrl = buildUrl()

  try {
    await session.login(
      {
        id: crypto.randomUUID(),
        name: login.value,
        baseUrl: finalUrl,
        db: db.value
      },
      password.value
    )
    router.push('/import')
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('login.loginFailed')
    // Show advanced options on error
    showAdvanced.value = true
  } finally {
    loading.value = false
  }
}

function onProfileSelect(event: Event) {
  const id = (event.target as HTMLSelectElement).value
  selectedProfileId.value = id

  if (!id) return

  const profile = savedProfiles.value.find(p => p.id === id)
  if (profile) {
    parseUrl(profile.baseUrl)
    db.value = profile.db
    login.value = profile.name
  }
}

function removeSelectedProfile() {
  const id = selectedProfileId.value
  if (!id) return

  const idx = session.savedProfiles.findIndex(p => p.id === id)
  if (idx >= 0) {
    session.savedProfiles.splice(idx, 1)
    // Convert to plain objects for IPC (Vue proxies can't be cloned)
    window.api.store.set('profiles', JSON.parse(JSON.stringify(session.savedProfiles)))
    selectedProfileId.value = ''
  }
}
</script>

<template>
  <div class="csv-min-h-screen csv-flex csv-items-center csv-justify-center csv-p-4">
    <Card class="csv-w-full csv-max-w-md csv-p-6">
      <h1 class="csv-text-2xl csv-font-semibold csv-mb-6">
        {{ $t('login.title') }}
      </h1>

      <div v-if="savedProfiles.length > 0" class="csv-mb-4">
        <label class="csv-text-sm csv-text-muted csv-mb-2 csv-block">
          {{ $t('login.savedConnections') }}
        </label>
        <div class="csv-flex csv-gap-2">
          <select
            class="csv-login__saved-select csv-flex-1"
            @change="onProfileSelect($event)"
          >
            <option value="">{{ $t('login.selectConnection') }}</option>
            <option
              v-for="profile in savedProfiles"
              :key="profile.id"
              :value="profile.id"
            >
              {{ profile.name }} ({{ profile.db }} - {{ profile.baseUrl }})
            </option>
          </select>
          <button
            v-if="selectedProfileId"
            type="button"
            class="csv-login__remove-btn"
            :title="$t('common.remove')"
            @click="removeSelectedProfile"
          >
            &times;
          </button>
        </div>
      </div>

      <Divider v-if="savedProfiles.length > 0" :label="$t('login.orConnectManually')" class="csv-mb-4" />

      <form @submit.prevent="handleLogin" class="csv-space-y-4">
        <div>
          <label class="csv-text-sm csv-font-medium csv-mb-1 csv-block">
            {{ $t('login.serverHost') }}
          </label>
          <Input
            v-model="host"
            :placeholder="$t('login.serverHostPlaceholder')"
            required
          />
        </div>

        <!-- Advanced options (port/SSL) - collapsible -->
        <div class="csv-advanced-panel">
          <button
            type="button"
            class="csv-advanced-panel__toggle"
            @click="showAdvanced = !showAdvanced"
          >
            <svg
              class="csv-advanced-panel__chevron"
              :class="{ 'csv-advanced-panel__chevron--open': showAdvanced }"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
            <span>{{ $t('login.advancedOptions') }}</span>
            <span v-if="!showAdvanced && (port || !useSSL)" class="csv-advanced-panel__summary">
              {{ port ? `:${port}` : '' }}{{ !useSSL ? ' HTTP' : '' }}
            </span>
          </button>
          <div v-show="showAdvanced" class="csv-advanced-panel__body">
            <div class="csv-flex csv-gap-3">
              <div class="csv-flex-1">
                <label class="csv-text-sm csv-font-medium csv-mb-1 csv-block">
                  {{ $t('login.port') }}
                </label>
                <Input
                  v-model="port"
                  placeholder="8069"
                  type="number"
                />
              </div>
              <div class="csv-flex csv-items-end csv-pb-1">
                <label class="csv-flex csv-items-center csv-gap-2 csv-cursor-pointer">
                  <input
                    v-model="useSSL"
                    type="checkbox"
                    class="csv-w-4 csv-h-4"
                  />
                  <span class="csv-text-sm">{{ $t('login.ssl') }}</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div>
          <label class="csv-text-sm csv-font-medium csv-mb-1 csv-block">
            {{ $t('login.database') }}
          </label>
          <Input
            v-model="db"
            :placeholder="$t('login.databasePlaceholder')"
            required
          />
        </div>

        <div>
          <label class="csv-text-sm csv-font-medium csv-mb-1 csv-block">
            {{ $t('login.username') }}
          </label>
          <Input
            v-model="login"
            :placeholder="$t('login.usernamePlaceholder')"
            required
          />
        </div>

        <div>
          <label for="csv-password" class="csv-text-sm csv-font-medium csv-mb-1 csv-block">
            {{ $t('login.password') }}
          </label>
          <Input
            id="csv-password"
            v-model="password"
            type="password"
            required
          />
        </div>

        <div
          v-if="error"
          class="csv-p-3 csv-bg-red-50 csv-text-red-700 csv-rounded csv-text-sm"
        >
          {{ error }}
        </div>

        <Button
          type="submit"
          class="csv-w-full"
          :loading="loading"
          :disabled="loading"
        >
          {{ $t('login.connect') }}
        </Button>
      </form>
    </Card>
  </div>
</template>

<style scoped>
.csv-login__saved-select {
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  background: white;
  cursor: pointer;
  font-family: inherit;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.csv-login__saved-select:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}
.csv-login__remove-btn {
  padding: 0.5rem 0.75rem;
  font-size: 1rem;
  color: #6b7280;
  background: white;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.csv-login__remove-btn:hover {
  color: #dc2626;
  border-color: #dc2626;
}

/* Advanced options collapsible panel */
.csv-advanced-panel {
  border: 1px solid #e5e7eb;
  border-radius: var(--radius, 0.375rem);
  background: #fafafa;
}
.csv-advanced-panel__toggle {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  text-align: left;
  background: none;
  border: none;
  font: inherit;
  font-size: 0.75rem;
  color: #6b7280;
  cursor: pointer;
}
.csv-advanced-panel__toggle:hover {
  background: #f3f4f6;
  border-radius: var(--radius, 0.375rem);
}
.csv-advanced-panel__chevron {
  width: 0.875rem;
  height: 0.875rem;
  flex-shrink: 0;
  color: #9ca3af;
  transition: transform 0.15s;
}
.csv-advanced-panel__chevron--open {
  transform: rotate(90deg);
}
.csv-advanced-panel__summary {
  color: #9ca3af;
  font-size: 0.75rem;
}
.csv-advanced-panel__body {
  padding: 0 0.75rem 0.75rem;
  border-top: 1px solid #e5e7eb;
}
</style>
