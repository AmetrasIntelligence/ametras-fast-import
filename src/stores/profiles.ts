import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ImportProfile } from '@/types/importProfile'
import {
  fetchProfiles,
  fetchProfile,
  deleteProfile as apiDeleteProfile,
  createProfile as apiCreateProfile,
  updateProfile as apiUpdateProfile,
  type ProfileCreateData
} from '@/api/profileApi'

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export const useProfilesStore = defineStore('profiles', () => {
  const profiles = ref<Map<number, ImportProfile>>(new Map())
  const loading = ref(false)
  const lastFetch = ref<number>(0)

  /**
   * Load all profiles from the server. Uses cache if not expired.
   */
  async function loadProfiles(force = false) {
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
   * Load a single profile with full data from the server.
   */
  async function loadProfile(id: number): Promise<ImportProfile> {
    const profile = await fetchProfile(id)
    profiles.value.set(id, profile)
    return profile
  }

  /**
   * Add a profile to the local cache (e.g. after upload).
   */
  function cacheProfile(profile: ImportProfile) {
    profiles.value.set(profile.id, profile)
  }

  /**
   * Get a profile from the cache.
   */
  function getProfile(id: number): ImportProfile | undefined {
    return profiles.value.get(id)
  }

  /**
   * Delete a profile from the server and remove from cache.
   */
  async function deleteProfile(id: number) {
    await apiDeleteProfile(id)
    profiles.value.delete(id)
  }

  /**
   * Create a new profile on the server and add to cache.
   */
  async function createProfile(data: ProfileCreateData): Promise<ImportProfile> {
    const profile = await apiCreateProfile(data)
    profiles.value.set(profile.id, profile)
    return profile
  }

  /**
   * Update an existing profile on the server and update cache.
   */
  async function updateProfile(id: number, data: Partial<ProfileCreateData>): Promise<ImportProfile> {
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
   */
  const profileList = computed(() => {
    return Array.from(profiles.value.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
  })

  return {
    profiles,
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
