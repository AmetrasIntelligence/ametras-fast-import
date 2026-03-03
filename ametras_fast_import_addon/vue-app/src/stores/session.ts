import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type AuthMode = 'standalone' | 'embedded'

export interface ServerProfile {
  id: string
  name: string
  baseUrl: string
  db: string
}

export const useSessionStore = defineStore('session', () => {
  const mode = ref<AuthMode>('standalone')
  const currentServer = ref<ServerProfile | null>(null)
  const uid = ref<number | null>(null)
  const serverVersion = ref<string | null>(null)
  const savedProfiles = ref<ServerProfile[]>([])
  const inDialog = ref(false)
  const expandProfileId = ref<number | null>(null)

  const isAuthenticated = computed(() => uid.value !== null)
  const isEmbedded = computed(() => mode.value === 'embedded')
  const baseUrl = computed((): string | null => {
    if (currentServer.value == null) return null
    // In embedded mode baseUrl is "" (same-origin); return "/" so
    // callers that guard with `if (!session.baseUrl)` still pass.
    return currentServer.value.baseUrl || '/'
  })

  /**
   * Set authenticated session state. Called by the client login flow
   * or by setEmbeddedMode for addon mode.
   */
  function setAuthenticated(profile: ServerProfile, newUid: number, newServerVersion: string) {
    currentServer.value = profile
    uid.value = newUid
    serverVersion.value = newServerVersion
  }

  function logout() {
    currentServer.value = null
    uid.value = null
    serverVersion.value = null
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

  function setDialogMode(value: boolean) {
    inDialog.value = value
  }

  function setExpandProfileId(id: number | null) {
    expandProfileId.value = id
  }

  return {
    mode,
    currentServer,
    uid,
    serverVersion,
    savedProfiles,
    inDialog,
    expandProfileId,
    isAuthenticated,
    isEmbedded,
    baseUrl,
    setAuthenticated,
    logout,
    loadProfiles,
    setEmbeddedMode,
    setDialogMode,
    setExpandProfileId
  }
})
