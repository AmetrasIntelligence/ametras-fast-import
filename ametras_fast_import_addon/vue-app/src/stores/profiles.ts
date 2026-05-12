import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ImportProfile } from '@/types/importProfile'
import { useSessionStore } from '@/stores/session'
import {
  fetchProfiles,
  fetchProfile,
  deleteProfile as apiDeleteProfile,
  createProfile as apiCreateProfile,
  updateProfile as apiUpdateProfile,
  type ProfileCreateData
} from '@/api/profileApi'
import {
  loadStandaloneProfiles,
  deleteStandaloneProfile as deleteLocalProfile,
  getStandaloneProfile,
  createStandaloneProfile,
  updateStandaloneProfile,
  pushProfileToServer,
  type StandaloneTarget
} from '@/api/profileStorage'

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export const useProfilesStore = defineStore('profiles', () => {
  const profiles = ref<Map<number, ImportProfile>>(new Map())
  const standaloneProfiles = ref<Map<number, ImportProfile>>(new Map())
  const loading = ref(false)
  const lastFetch = ref<number>(0)

  /**
   * Load all profiles from the server. Uses cache if not expired.
   * Also loads standalone profiles from local storage.
   */
  async function loadProfiles(force = false) {
  
    const session = useSessionStore()

    // Always load standalone profiles from local storage
    await loadLocalProfiles()

    if (!session.isEmbedded) {
      // Server profiles not available in standalone mode (addon not installed)
      return
    }

    const now = Date.now()
    if (!force && lastFetch.value > 0 && now - lastFetch.value < CACHE_TTL) {
      return
    }

    loading.value = true
    try {
      const serverProfiles = await fetchProfiles()
      const newMap = new Map<number, ImportProfile>()
      for (const p of serverProfiles) {
        // Preserve full data if already cached
        const existing = profiles.value.get(p.id)
        if (existing && existing.mappings.length > 0) {
          newMap.set(p.id, { ...existing, ...p, mappings: existing.mappings, sequence: existing.sequence, runSettings: existing.runSettings })
        } else {
          newMap.set(p.id, p)
        }
      }
      profiles.value = newMap
      lastFetch.value = now
    } finally {
      loading.value = false
    }
  }

  /**
   * Load standalone profiles from local storage.
   */
  async function loadLocalProfiles() {
    const localProfiles = await loadStandaloneProfiles()
    const newMap = new Map<number, ImportProfile>()
    for (const p of localProfiles) {
      newMap.set(p.id, p)
    }
    standaloneProfiles.value = newMap
  }

  /**
   * Load a single profile with full data from the server.
   */
  async function loadProfile(id: number): Promise<ImportProfile> {
  
    // Check if it's a standalone profile (stored as ir.attachment)
    if (standaloneProfiles.value.has(id)) {
      const localProfile = await getStandaloneProfile(id)
      if (localProfile) {
        standaloneProfiles.value.set(id, localProfile)
        return localProfile
      }
      throw new Error('Standalone profile not found')
    }

    const profile = await fetchProfile(id)
    profiles.value.set(id, profile)
    return profile
  }

  /**
   * Add a profile to the local cache (e.g. after upload).
   */
  function cacheProfile(profile: ImportProfile) {
  
    if (profile.isStandalone) {
      standaloneProfiles.value.set(profile.id, profile)
    } else {
      profiles.value.set(profile.id, profile)
    }
  }

  /**
   * Get a profile from the cache.
   */
  function getProfile(id: number): ImportProfile | undefined {
  
    if (standaloneProfiles.value.has(id)) {
      return standaloneProfiles.value.get(id)
    }
    return profiles.value.get(id)
  }

  /**
   * Delete a profile from the server (or local storage for standalone).
   */
  async function deleteProfile(id: number) {
  
    if (standaloneProfiles.value.has(id)) {
      await deleteLocalProfile(id)
      standaloneProfiles.value.delete(id)
      return
    }
    await apiDeleteProfile(id)
    profiles.value.delete(id)
  }

  /**
   * Create a new profile on the server (or local storage in standalone mode).
   */
  async function createProfile(data: ProfileCreateData, target?: StandaloneTarget): Promise<ImportProfile> {
    const session = useSessionStore()
    if (!session.isEmbedded) {
      const profile = await createStandaloneProfile(data, target || 'server')
      standaloneProfiles.value.set(profile.id, profile)
      return profile
    }
    const profile = await apiCreateProfile(data)
    profiles.value.set(profile.id, profile)
    return profile
  }

  /**
   * Push a local standalone profile to the server (ir.attachment).
   * Removes the local copy and returns the new server-stored profile.
   */
  async function pushToServer(localId: number): Promise<ImportProfile> {
    const serverProfile = await pushProfileToServer(localId)
    standaloneProfiles.value.delete(localId)
    standaloneProfiles.value.set(serverProfile.id, serverProfile)
    return serverProfile
  }

  /**
   * Update an existing profile on the server (or local storage for standalone).
   */
  async function updateProfile(id: number, data: Partial<ProfileCreateData>): Promise<ImportProfile> {
    if (standaloneProfiles.value.has(id)) {
      const profile = await updateStandaloneProfile(id, data)
      standaloneProfiles.value.set(id, profile)
      return profile
    }
    const profile = await apiUpdateProfile(id, data)
    profiles.value.set(id, profile)
    return profile
  }

  /**
   * Force next loadProfiles to refetch.
   */
  function invalidateCache() {
    lastFetch.value = 0
  }

  /**
   * Sorted profile list (by updatedAt desc).
   * Includes both server and standalone profiles.
   */
  const profileList = computed(() => {
  
    const all = [
      ...Array.from(profiles.value.values()),
      ...Array.from(standaloneProfiles.value.values())
    ]
    return all.sort((a, b) => b.updatedAt - a.updatedAt)
  })

  /**
   * Standalone profiles only (sorted by updatedAt desc).
   */
  const standaloneProfileList = computed(() => {
    return Array.from(standaloneProfiles.value.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
  })

  /**
   * Server profiles only (sorted by updatedAt desc).
   */
  const serverProfileList = computed(() => {
    return Array.from(profiles.value.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
  })

  return {
    profiles,
    standaloneProfiles,
    loading,
    lastFetch,
    loadProfiles,
    loadLocalProfiles,
    loadProfile,
    cacheProfile,
    getProfile,
    deleteProfile,
    createProfile,
    updateProfile,
    pushToServer,
    invalidateCache,
    profileList,
    standaloneProfileList,
    serverProfileList
  }
})
