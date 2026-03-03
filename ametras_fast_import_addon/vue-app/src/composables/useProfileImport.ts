import { ref } from 'vue'
import { uploadProfileZip } from '@/api/profileApi'
import { useProfilesStore } from '@/stores/profiles'
import type { ImportProfile } from '@/types/importProfile'

export function useProfileImport() {
  const importing = ref(false)
  const error = ref<string | null>(null)

  async function importProfile(): Promise<ImportProfile | null> {
    error.value = null

    // Open file dialog
    const selection = await window.api.profile.selectZip()
    if (!selection) return null

    importing.value = true
    try {
      const profile = await uploadProfileZip(selection.path)

      // Cache in store
      const profiles = useProfilesStore()
      profiles.cacheProfile(profile)

      return profile
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Import failed'
      return null
    } finally {
      importing.value = false
    }
  }

  return {
    importing,
    error,
    importProfile
  }
}
