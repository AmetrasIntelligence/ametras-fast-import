<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { Button, Input, Card } from '@/ui'

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

const savedProfiles = computed(() => session.savedProfiles)

onMounted(async () => {
  if (session.isAuthenticated) {
    router.push('/files')
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
    router.push('/files')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Login failed'
    // Show advanced options on error
    showAdvanced.value = true
  } finally {
    loading.value = false
  }
}

function selectProfile(profile: typeof savedProfiles.value[0]) {
  parseUrl(profile.baseUrl)
  db.value = profile.db
  login.value = profile.name
}

function removeProfile(profile: typeof savedProfiles.value[0], event: Event) {
  event.stopPropagation()
  const idx = session.savedProfiles.findIndex(p => p.id === profile.id)
  if (idx >= 0) {
    session.savedProfiles.splice(idx, 1)
    // Convert to plain objects for IPC (Vue proxies can't be cloned)
    window.api.store.set('profiles', JSON.parse(JSON.stringify(session.savedProfiles)))
  }
}
</script>

<template>
  <div class="csv-min-h-screen csv-flex csv-items-center csv-justify-center csv-p-4">
    <Card class="csv-w-full csv-max-w-md csv-p-6">
      <h1 class="csv-text-2xl csv-font-semibold csv-mb-6">
        Odoo Connection
      </h1>

      <div v-if="savedProfiles.length > 0" class="csv-mb-6">
        <label class="csv-text-sm csv-text-muted csv-mb-2 csv-block">
          Saved Connections
        </label>
        <div class="csv-flex csv-flex-col csv-gap-2">
          <div
            v-for="profile in savedProfiles"
            :key="profile.id"
            class="csv-flex csv-items-center csv-gap-2 csv-p-2 csv-border csv-rounded csv-cursor-pointer hover:csv-bg-gray-50"
            @click="selectProfile(profile)"
          >
            <div class="csv-flex-1 csv-min-w-0">
              <div class="csv-text-sm csv-font-medium csv-truncate">{{ profile.name }}</div>
              <div class="csv-text-xs csv-text-gray-500 csv-truncate">{{ profile.baseUrl }} / {{ profile.db }}</div>
            </div>
            <button
              type="button"
              class="csv-text-gray-400 hover:csv-text-red-500 csv-p-1"
              title="Remove"
              @click="removeProfile(profile, $event)"
            >
              &times;
            </button>
          </div>
        </div>
      </div>

      <form @submit.prevent="handleLogin" class="csv-space-y-4">
        <div>
          <label class="csv-text-sm csv-font-medium csv-mb-1 csv-block">
            Server Host
          </label>
          <Input
            v-model="host"
            placeholder="mycompany.odoo.com or localhost"
            required
          />
        </div>

        <!-- Advanced options (port/SSL) - shown on error or toggle -->
        <div v-if="showAdvanced" class="csv-flex csv-gap-3">
          <div class="csv-flex-1">
            <label class="csv-text-sm csv-font-medium csv-mb-1 csv-block">
              Port
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
              <span class="csv-text-sm">SSL (https)</span>
            </label>
          </div>
        </div>
        <button
          v-else
          type="button"
          class="csv-text-xs csv-text-blue-600 hover:csv-underline"
          @click="showAdvanced = true"
        >
          Show port &amp; SSL options
        </button>

        <div>
          <label class="csv-text-sm csv-font-medium csv-mb-1 csv-block">
            Database
          </label>
          <Input
            v-model="db"
            placeholder="database name"
            required
          />
        </div>

        <div>
          <label class="csv-text-sm csv-font-medium csv-mb-1 csv-block">
            Username
          </label>
          <Input
            v-model="login"
            placeholder="admin@example.com"
            required
          />
        </div>

        <div>
          <label for="csv-password" class="csv-text-sm csv-font-medium csv-mb-1 csv-block">
            Password
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
          Connect
        </Button>
      </form>
    </Card>
  </div>
</template>
