<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '@/stores/session'
import { useClientSession } from '../composables/useClientSession'
import { isPythonAvailable } from '../standalone/pythonExecutor'
import { Button, Card } from '@/ui'

const { t } = useI18n()

const router = useRouter()
const session = useSessionStore()
const clientSession = useClientSession()

const appVersion = __APP_VERSION__

const host = ref('')
const port = ref('')
const useSSL = ref(true)
const db = ref('')
const login = ref('')
const password = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
// Discovered databases for the entered server. Empty → fall back to manual entry
// (server has db listing disabled, is unreachable, or hasn't been probed yet).
const databases = ref<string[]>([])
const dbListLoading = ref(false)
const showAdvanced = ref(false)
const selectedProfileId = ref('')
const showEncryptionPrompt = ref(false)
const encryptionInfo = ref<{ available: boolean; platform: string } | null>(null)
const pythonMissing = ref(false)

const savedProfiles = computed(() => session.savedProfiles)

const profileOptions = computed(() =>
  savedProfiles.value.map(p => ({
    value: p.id,
    label: `${p.name} (${p.db} - ${p.baseUrl})`
  }))
)

onMounted(async () => {
  if (session.isAuthenticated) {
    router.push('/import')
    return
  }

  // Run profile loading and Python detection in parallel.
  // Python detection can be slow (multiple path probes with timeouts) and must
  // not block profile loading — otherwise saved connections won't appear until
  // detection finishes.
  const [hasPython] = await Promise.all([
    isPythonAvailable(),
    session.loadProfiles(),
    window.api.odoo.getEncryptionInfo().then(info => { encryptionInfo.value = info }),
  ])
  pythonMissing.value = !hasPython

  // Linux without keyring: auto-disable and skip prompt
  if (encryptionInfo.value && !encryptionInfo.value.available) {
    const pref = await window.api.store.get('credentialEncryption')
    if (pref == null) {
      await window.api.store.set('credentialEncryption', 'disabled')
    }
  }
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

// Probe the server for its database list (pre-auth, no credentials needed).
// On success we show a dropdown; if listing is disabled/unreachable we silently
// fall back to the manual text field. Standalone mode only.
async function discoverDatabases() {
  if (!host.value.trim()) return
  dbListLoading.value = true
  try {
    const res = await window.api.odoo.listDatabases(buildUrl())
    if (res.ok && res.databases.length > 0) {
      databases.value = res.databases
      // Single-tenant servers: auto-select the only db. If the current value
      // isn't among the discovered ones, clear it so the user must pick.
      if (databases.value.length === 1) {
        db.value = databases.value[0]
      } else if (db.value && !databases.value.includes(db.value)) {
        db.value = ''
      }
    } else {
      databases.value = []
    }
  } catch {
    databases.value = []
  } finally {
    dbListLoading.value = false
  }
}

async function handleLogin() {
  // Check if user has made a credential storage choice yet
  const pref = await window.api.store.get('credentialEncryption')
  if (pref == null && encryptionInfo.value?.available) {
    showEncryptionPrompt.value = true
    return
  }

  loading.value = true
  error.value = null

  const finalUrl = buildUrl()

  try {
    await clientSession.login(
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

async function onEncryptionChoice(enabled: boolean) {
  await window.api.store.set('credentialEncryption', enabled ? 'enabled' : 'disabled')
  showEncryptionPrompt.value = false
  handleLogin()
}

function onProfileSelect(id: string) {
  selectedProfileId.value = id

  if (!id) return

  const profile = savedProfiles.value.find(p => p.id === id)
  if (profile) {
    parseUrl(profile.baseUrl)
    db.value = profile.db
    login.value = profile.name
    // Refresh the db list for the profile's server (keeps profile.db selected
    // if it's still present; falls back to text entry otherwise).
    discoverDatabases()
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
      <div class="d-flex justify-content-between align-items-baseline mb-4">
        <h1 class="fs-4 fw-semibold mb-0">
          {{ $t('login.title') }}
        </h1>
        <small v-if="appVersion" class="text-body-tertiary" style="font-size: 0.675rem;">v{{ appVersion }}</small>
      </div>

      <div v-if="pythonMissing" class="alert alert-danger py-2 small mb-3">
        <div class="fw-semibold">Python runtime not found</div>
        <div class="mt-1">
          This application needs Python 3.8 or later to import CSV files.
          Packaged builds should include the runtime automatically.
        </div>
        <div class="mt-1 text-body-secondary" style="font-size: 0.7rem;">
          Checked bundled runtime, python3/python on PATH, and common install locations.
        </div>
      </div>

      <div v-if="savedProfiles.length > 0" class="mb-3">
        <label class="form-label small text-body-secondary">
          {{ $t('login.savedConnections') }}
        </label>
        <div class="d-flex gap-2">
          <select
            :value="selectedProfileId"
            class="form-select form-select-sm flex-grow-1"
            @change="onProfileSelect(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ $t('login.selectConnection') }}</option>
            <option v-for="opt in profileOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <Button
            v-if="selectedProfileId"
            variant="destructive"
            size="sm"
            :title="$t('common.remove')"
            @click="removeSelectedProfile"
          >
            &times;
          </Button>
        </div>
      </div>

      <div v-if="savedProfiles.length > 0" class="d-flex align-items-center gap-2 mb-3">
        <hr class="flex-grow-1" /><small class="text-body-secondary text-nowrap">{{ $t('login.orConnectManually') }}</small><hr class="flex-grow-1" />
      </div>

      <form class="d-flex flex-column gap-3" @submit.prevent="handleLogin">
        <div>
          <label for="csv-host" class="form-label small fw-medium mb-1">
            {{ $t('login.serverHost') }}
          </label>
          <input
            id="csv-host"
            v-model="host"
            class="form-control form-control-sm"
            :placeholder="$t('login.serverHostPlaceholder')"
            required
            @blur="discoverDatabases"
          />
        </div>

        <!-- Advanced options (port/SSL) - collapsible -->
        <div class="csv-advanced-panel">
          <button
            type="button"
            class="csv-advanced-panel__toggle"
            :aria-expanded="showAdvanced"
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
                <label for="csv-port" class="form-label small fw-medium mb-1">
                  {{ $t('login.port') }}
                </label>
                <input
                  id="csv-port"
                  v-model="port"
                  class="form-control form-control-sm"
                  placeholder="8069"
                  type="number"
                  min="1"
                  max="65535"
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
          <label for="csv-database" class="form-label small fw-medium mb-1">
            {{ $t('login.database') }}
            <span v-if="dbListLoading" class="text-body-tertiary fw-normal" style="font-size: 0.7rem;">…</span>
          </label>
          <!-- Dropdown when the server exposes its db list; manual entry otherwise. -->
          <select
            v-if="databases.length > 0"
            id="csv-database"
            v-model="db"
            class="form-select form-select-sm"
            required
          >
            <option value="" disabled>{{ $t('login.databasePlaceholder') }}</option>
            <option v-for="d in databases" :key="d" :value="d">{{ d }}</option>
          </select>
          <input
            v-else
            id="csv-database"
            v-model="db"
            class="form-control form-control-sm"
            :placeholder="$t('login.databasePlaceholder')"
            required
          />
        </div>

        <div>
          <label for="csv-username" class="form-label small fw-medium mb-1">
            {{ $t('login.username') }}
          </label>
          <input
            id="csv-username"
            v-model="login"
            class="form-control form-control-sm"
            :placeholder="$t('login.usernamePlaceholder')"
            required
          />
        </div>

        <div>
          <label for="csv-password" class="form-label small fw-medium mb-1">
            {{ $t('login.password') }}
          </label>
          <input
            id="csv-password"
            v-model="password"
            class="form-control form-control-sm"
            type="password"
            required
          />
        </div>

        <!-- One-time encryption prompt -->
        <div v-if="showEncryptionPrompt" class="alert alert-info py-2 small mb-0">
          <div class="fw-semibold mb-1">{{ $t('login.credentialStorage') }}</div>
          <p class="mb-1">{{ $t('login.credentialStorageDesc') }}</p>
          <p v-if="encryptionInfo?.platform === 'darwin'" class="mb-2 text-body-secondary">
            {{ $t('login.credentialStorageMac') }}
          </p>
          <p v-else-if="encryptionInfo?.platform === 'linux'" class="mb-2 text-body-secondary">
            {{ $t('login.credentialStorageLinux') }}
          </p>
          <div class="d-flex gap-2">
            <Button size="sm" @click="onEncryptionChoice(true)">
              {{ $t('login.enableSecureStorage') }}
            </Button>
            <Button size="sm" variant="secondary" @click="onEncryptionChoice(false)">
              {{ $t('login.dontSave') }}
            </Button>
          </div>
        </div>

        <!-- Linux without keyring info -->
        <div
          v-if="encryptionInfo && !encryptionInfo.available && encryptionInfo.platform === 'linux'"
          class="alert alert-warning py-2 small mb-0"
        >
          {{ $t('login.credentialStorageUnavailable') }}
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
          :disabled="loading || pythonMissing"
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
