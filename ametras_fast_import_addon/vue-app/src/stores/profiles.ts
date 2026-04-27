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
  deleteStandaloneProfile,
  getStandaloneProfile,
  createStandaloneProfile,
  updateStandaloneProfile
} from '@/services/standaloneProfiles'

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export const useProfilesStore = defineStore('profiles', () => {
  const profiles = ref<Map<number, ImportProfile>>(new Map())
  const standaloneProfiles = ref<Map<number, ImportProfile>>(new Map())
  const loading = ref(false)
  const lastFetch = ref<number>(0)

  /**
   * Load profiles for the active mode.
   * - Embedded addon mode: `csv.import.profile`
   * - Standalone mode: `ir.attachment` profiles
   */
  async function loadProfiles(force = false) {
    const session = useSessionStore()

    const now = Date.now()
    if (!force && lastFetch.value > 0 && now - lastFetch.value < CACHE_TTL) {
      return
    }

    loading.value = true
    try {
      if (session.isEmbedded) {
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
        standaloneProfiles.value = new Map()
      } else {
        const serverAttachmentProfiles = await loadStandaloneProfiles()
        const newMap = new Map<number, ImportProfile>()
        for (const p of serverAttachmentProfiles) {
          newMap.set(p.id, p)
        }
        standaloneProfiles.value = newMap
        profiles.value = new Map()
      }
      lastFetch.value = now
    } finally {
      loading.value = false
    }
  }

  /**
   * Load a single profile with full data from the server.
   */
  async function loadProfile(id: number): Promise<ImportProfile> {
    const session = useSessionStore()
    if (!session.isEmbedded) {
      const profile = await getStandaloneProfile(id)
      if (!profile) {
        throw new Error('Profile not found')
      }
      standaloneProfiles.value.set(id, profile)
      return profile
    }

    const profile = await fetchProfile(id)
    profiles.value.set(id, profile)
    return profile
  }

  /**
   * Add a profile to the local cache (e.g. after upload).
   */
  function cacheProfile(profile: ImportProfile) {
    const session = useSessionStore()
    if (!session.isEmbedded || profile.isStandalone) {
      standaloneProfiles.value.set(profile.id, profile)
    } else {
      profiles.value.set(profile.id, profile)
    }
  }

  /**
   * Get a profile from the cache.
   */
  function getProfile(id: number): ImportProfile | undefined {
    const session = useSessionStore()
    if (!session.isEmbedded) {
      return standaloneProfiles.value.get(id)
    }
    return profiles.value.get(id)
  }

  /**
   * Delete a profile from the active server backend.
   */
  async function deleteProfile(id: number) {
    const session = useSessionStore()
    if (!session.isEmbedded) {
      await deleteStandaloneProfile(id)
      standaloneProfiles.value.delete(id)
      return
    }
    await apiDeleteProfile(id)
    profiles.value.delete(id)
  }

  /**
   * Create a profile on the active server backend.
   */
  async function createProfile(data: ProfileCreateData): Promise<ImportProfile> {
    const session = useSessionStore()
    if (!session.isEmbedded) {
      const profile = await createStandaloneProfile(data)
      standaloneProfiles.value.set(profile.id, profile)
      return profile
    }
    const profile = await apiCreateProfile(data)
    profiles.value.set(profile.id, profile)
    return profile
  }

  /**
   * Update an existing profile on the active server backend.
   */
  async function updateProfile(id: number, data: Partial<ProfileCreateData>): Promise<ImportProfile> {
    const session = useSessionStore()
    if (!session.isEmbedded) {
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
   * Returns the active backend list for the current mode.
   */
  const profileList = computed(() => {
    const session = useSessionStore()
    if (session.isEmbedded) {
      return Array.from(profiles.value.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
    }
    return Array.from(standaloneProfiles.value.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
  })

  return {
    profiles,
    standaloneProfiles,
    loading,
    lastFetch,
    loadProfiles,
    loadProfile,
    cacheProfile,
    getProfile,
    deleteProfile,
    createProfile,
    updateProfile,
    invalidateCache,
    profileList
  }
})
