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

// Build URL from components.
// Supports hosts with paths (e.g. "mycompany.com/odoo") and inline ports.
function buildUrl(): string {
  let raw = host.value.trim()

  // Strip protocol if user pasted a full URL
  raw = raw.replace(/^https?:\/\//i, '')

  // Strip trailing slashes
  raw = raw.replace(/\/+$/, '')

  const protocol = useSSL.value ? 'https://' : 'http://'

  try {
    const parsed = new URL(protocol + raw)
    // Port field overrides any inline port in the host input
    if (port.value) {
      parsed.port = port.value
    }
    const path = parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : ''
    return parsed.origin + path
  } catch {
    // Fallback: manual string construction
    const slashIdx = raw.indexOf('/')
    let hostPart = slashIdx >= 0 ? raw.substring(0, slashIdx) : raw
    const pathPart = slashIdx >= 0 ? raw.substring(slashIdx) : ''
    // Strip inline port from host if port field overrides it
    if (port.value) {
      hostPart = hostPart.replace(/:\d+$/, '')
    }
    let url = protocol + hostPart
    if (port.value) {
      url += ':' + port.value
    }
    url += pathPart
    return url
  }
}

// Parse a full URL into form components (protocol, host+path, port).
// Used when loading saved connection profiles.
function parseUrl(url: string) {
  try {
    const parsed = new URL(url)
    useSSL.value = parsed.protocol === 'https:'
    const path = parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : ''
    host.value = parsed.hostname + path
    port.value = parsed.port
  } catch {
    // Fallback regex: handles protocol://host(:port)?(/path)?
    const match = url.match(/^(https?):\/\/([^:/]+)(?::(\d+))?(\/\S*)?/)
    if (match) {
      useSSL.value = match[1] === 'https'
      const path = match[4] ? match[4].replace(/\/+$/, '') : ''
      host.value = match[2] + path
      port.value = match[3] || ''
    } else {
      host.value = url
    }
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
  <div class="min-vh-100 d-flex align-items-center justify-content-center p-3">
    <Card class="w-100 p-4" style="max-width: 28rem;">
      <h1 class="fs-4 fw-semibold mb-4">
        {{ $t('login.title') }}
      </h1>

      <div v-if="savedProfiles.length > 0" class="mb-3">
        <label class="form-label small text-body-secondary">
          {{ $t('login.savedConnections') }}
        </label>
        <div class="d-flex gap-2">
          <select
            class="form-select form-select-sm flex-grow-1"
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
            class="btn btn-outline-danger btn-sm"
            :title="$t('common.remove')"
            @click="removeSelectedProfile"
          >
            &times;
          </button>
        </div>
      </div>

      <Divider v-if="savedProfiles.length > 0" :label="$t('login.orConnectManually')" class="mb-3" />

      <form @submit.prevent="handleLogin" class="d-flex flex-column gap-3">
        <div>
          <label class="form-label small fw-medium mb-1">
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
            <span v-if="!showAdvanced && (port || !useSSL)" class="text-body-tertiary" style="font-size: 0.75rem;">
              {{ port ? `:${port}` : '' }}{{ !useSSL ? ' HTTP' : '' }}
            </span>
          </button>
          <div v-show="showAdvanced" class="csv-advanced-panel__body">
            <div class="d-flex gap-3">
              <div class="flex-grow-1">
                <label class="form-label small fw-medium mb-1">
                  {{ $t('login.port') }}
                </label>
                <Input
                  v-model="port"
                  placeholder="8069"
                  type="number"
                />
              </div>
              <div class="d-flex align-items-end pb-1">
                <label class="d-flex align-items-center gap-2 cursor-pointer">
                  <input
                    v-model="useSSL"
                    type="checkbox"
                    class="form-check-input"
                  />
                  <span class="small">{{ $t('login.ssl') }}</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div>
          <label class="form-label small fw-medium mb-1">
            {{ $t('login.database') }}
          </label>
          <Input
            v-model="db"
            :placeholder="$t('login.databasePlaceholder')"
            required
          />
        </div>

        <div>
          <label class="form-label small fw-medium mb-1">
            {{ $t('login.username') }}
          </label>
          <Input
            v-model="login"
            :placeholder="$t('login.usernamePlaceholder')"
            required
          />
        </div>

        <div>
          <label for="csv-password" class="form-label small fw-medium mb-1">
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
          class="alert alert-danger py-2 small mb-0"
        >
          {{ error }}
        </div>

        <Button
          type="submit"
          class="w-100"
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
/* Advanced options collapsible panel */
.csv-advanced-panel {
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  background: var(--bs-tertiary-bg);
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
  color: var(--bs-secondary-color);
  cursor: pointer;
}
.csv-advanced-panel__toggle:hover {
  background: var(--bs-secondary-bg-subtle);
  border-radius: var(--bs-border-radius);
}
.csv-advanced-panel__chevron {
  width: 0.875rem;
  height: 0.875rem;
  flex-shrink: 0;
  color: var(--bs-secondary-color);
  transition: transform 0.15s;
}
.csv-advanced-panel__chevron--open {
  transform: rotate(90deg);
}
.csv-advanced-panel__body {
  padding: 0 0.75rem 0.75rem;
  border-top: 1px solid var(--bs-border-color);
}
.cursor-pointer { cursor: pointer; }
</style>
