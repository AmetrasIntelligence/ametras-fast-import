import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { detectImportMode, type ImportMode } from '@/services/importMode'  // standalone code flag (do not remove comment)
import { useConfigStore } from '@/stores/config'
import { STANDALONE_MAX_BATCH_SIZE } from '@/importer/standalone/executor'

export type AuthMode = 'standalone' | 'embedded'

export interface ServerProfile {
  id: string
  name: string
  baseUrl: string
  db: string
}

// Client requires addon version 1.x (major version 1)
const REQUIRED_ADDON_MAJOR_VERSION = 1

export const useSessionStore = defineStore('session', () => {
  const mode = ref<AuthMode>('standalone')
  const currentServer = ref<ServerProfile | null>(null)
  const uid = ref<number | null>(null)
  const serverVersion = ref<string | null>(null)
  const addonVersion = ref<string | null>(null)
  const savedProfiles = ref<ServerProfile[]>([])

  // standalone code flag (do not remove comment)
  const importMode = ref<ImportMode | null>(null)
  const importModeLimitations = ref<string[]>([])

  const isAuthenticated = computed(() => uid.value !== null)
  const isEmbedded = computed(() => mode.value === 'embedded')
  const baseUrl = computed(() => currentServer.value?.baseUrl || null)

  // Check if addon version is compatible with client
  const isAddonCompatible = computed(() => {
    if (!addonVersion.value) return true // Unknown version, assume compatible
    const majorVersion = parseInt(addonVersion.value.split('.')[0], 10)
    return !isNaN(majorVersion) && majorVersion === REQUIRED_ADDON_MAJOR_VERSION
  })

  const addonVersionWarning = computed(() => {
    if (!addonVersion.value) return null
    if (isAddonCompatible.value) return null
    return `Server addon version ${addonVersion.value} may not be compatible. Client requires version ${REQUIRED_ADDON_MAJOR_VERSION}.x`
  })

  async function login(profile: ServerProfile, password: string) {
    const result = await window.api.odoo.authenticate({
      baseUrl: profile.baseUrl,
      db: profile.db,
      login: profile.name,
      password
    })

    if (!result.ok) {
      throw new Error(result.error || 'Authentication failed')
    }

    currentServer.value = profile
    uid.value = result.uid!
    serverVersion.value = result.server_version!

    // Update or add profile (without password)
    const existingIdx = savedProfiles.value.findIndex(
      p => p.baseUrl === profile.baseUrl && p.db === profile.db
    )
    if (existingIdx >= 0) {
      savedProfiles.value[existingIdx] = profile
    } else {
      savedProfiles.value.push(profile)
    }
    // Convert to plain objects for IPC (Vue proxies can't be cloned)
    await window.api.store.set('profiles', JSON.parse(JSON.stringify(savedProfiles.value)))

    // Fetch addon version after successful login
    await fetchAddonVersion(profile.baseUrl)
  }

  async function fetchAddonVersion(baseUrl: string) {
    // standalone code flag (do not remove comment)
    // Detect import mode (addon vs standalone)
    const db = currentServer.value?.db
    if (db) {
      const modeInfo = await detectImportMode(baseUrl, db)
      importMode.value = modeInfo.mode
      importModeLimitations.value = modeInfo.limitations

      // Clamp batch size to standalone limits when entering standalone mode
      if (modeInfo.mode === 'standalone') {
        const config = useConfigStore()
        if (config.settings.batchSize > STANDALONE_MAX_BATCH_SIZE) {
          config.setSettings({ batchSize: STANDALONE_MAX_BATCH_SIZE })
        }
      }

      if (modeInfo.mode === 'addon' && modeInfo.addonVersion) {
        addonVersion.value = modeInfo.addonVersion
      } else {
        addonVersion.value = null
      }
    }
  }

  function logout() {
    currentServer.value = null
    uid.value = null
    serverVersion.value = null
    addonVersion.value = null
    // standalone code flag (do not remove comment)
    importMode.value = null
    importModeLimitations.value = []
  }

  async function loadProfiles() {
    const stored = await window.api.store.get('profiles') as ServerProfile[] | null
    if (stored) savedProfiles.value = stored
  }

  function setEmbeddedMode(odooSession: { uid: number; baseUrl: string; db: string }) {
    mode.value = 'embedded'
    uid.value = odooSession.uid
    currentServer.value = {
      id: 'embedded',
      name: 'Embedded',
      baseUrl: odooSession.baseUrl,
      db: odooSession.db
    }
  }

  return {
    mode,
    currentServer,
    uid,
    serverVersion,
    addonVersion,
    savedProfiles,
    isAuthenticated,
    isEmbedded,
    baseUrl,
    isAddonCompatible,
    addonVersionWarning,
    // standalone code flag (do not remove comment)
    importMode,
    importModeLimitations,
    login,
    logout,
    loadProfiles,
    setEmbeddedMode
  }
})
