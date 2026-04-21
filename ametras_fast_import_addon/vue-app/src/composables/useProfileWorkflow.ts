import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/files'
import { useConfigStore } from '@/stores/config'
import { usePlatformStore } from '@/stores/platform'
import { useProfilesStore } from '@/stores/profiles'
import type { ImportProfile, ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import type { FieldMapping } from '@/types/fieldMapping'
import { autoMapFields } from '@/utils/smartFieldMapping'
import { showAlert, showConfirm, showPrompt } from '@/composables/useDialog'
import type { useFieldMetadata } from '@/composables/useFieldMetadata'

export function useProfileWorkflow(fieldMeta: ReturnType<typeof useFieldMetadata>) {
  const { t } = useI18n()
  const filesStore = useFilesStore()
  const config = useConfigStore()
  const platform = usePlatformStore()
  const profiles = useProfilesStore()

  const activeProfile = ref<ImportProfile | null>(null)
  const profileLoading = ref(false)
  const profileLoadedAt = ref<number>(0)
  const lastEditAt = ref<number>(0)
  const isApplyingProfile = ref(false)
  const profileMissingFiles = ref<Set<string>>(new Set())

  // Mark as edited when config changes
  watch(
    () => [
      config.fileMappings,
      config.importSequence,
      config.settings,
      fieldMeta.transformOverrides.value.size
    ],
    () => {
      if (isApplyingProfile.value) return
      if (profileLoadedAt.value > 0) {
        lastEditAt.value = Date.now()
      }
    },
    { deep: true }
  )

  const hasUnsavedChanges = computed(() => {
    if (!activeProfile.value) return false
    return lastEditAt.value > profileLoadedAt.value
  })

  async function handleProfileSelect(id: number) {
    if (!id) {
      clearProfile()
      return
    }
    profileLoading.value = true
    isApplyingProfile.value = true
    try {
      const profile = await profiles.loadProfile(id)
      activeProfile.value = profile
      config.setActiveProfileId(profile.id)

      config.setSettings({ ...profile.runSettings })

      const uploadedFilenames = new Set(filesStore.files.map(f => f.name))

      // Apply file mappings from profile
      for (const mapping of profile.mappings) {
        if (!uploadedFilenames.has(mapping.filename)) continue

        const existing = config.getFileMapping(mapping.filename)
        config.setFileMapping(mapping.filename, {
          filename: mapping.filename,
          model: mapping.model,
          fieldMappings: existing?.fieldMappings || {},
          searchKeys: mapping.searchKeys,
          strict: mapping.strict
        })

        if (mapping.model) {
          await fieldMeta.ensureFieldsCached(mapping.model)
        }
      }

      // Apply rich field mappings
      const newRichMappings = new Map<string, FieldMapping[]>()
      const newTransformOverrides = new Map<string, import('@/types/fieldMapping').FieldTransform>()

      if (profile.richFieldMappings && profile.richFieldMappings.length > 0) {
        for (const fm of profile.richFieldMappings) {
          if (!uploadedFilenames.has(fm.filename)) continue

          const fileMapping = config.getFileMapping(fm.filename)
          const modelFields = fileMapping?.model ? fieldMeta.fieldsCache.value.get(fileMapping.model) : null
          if (modelFields) {
            const validFields = fieldMeta.buildValidFieldValues(modelFields)
            if (!validFields.has(fm.odooField)) continue
          }

          const existing = config.getFileMapping(fm.filename)
          if (existing) {
            const fieldMappings = { ...existing.fieldMappings, [fm.csvHeader]: fm.odooField }
            config.setFileMapping(fm.filename, { ...existing, fieldMappings })
          }

          if (!newRichMappings.has(fm.filename)) {
            newRichMappings.set(fm.filename, [])
          }
          newRichMappings.get(fm.filename)!.push(fm)

          if (fm.transform && fm.transform.type !== 'passthrough') {
            newTransformOverrides.set(`${fm.filename}:${fm.csvHeader}`, fm.transform)
          }
        }
      }

      fieldMeta.richFieldMappings.value = newRichMappings
      fieldMeta.transformOverrides.value = newTransformOverrides

      // Auto-map remaining unmapped headers
      for (const file of filesStore.files) {
        const fileMapping = config.getFileMapping(file.name)
        if (!fileMapping?.model) continue

        const analysis = filesStore.getAnalysis(file.id)
        if (!analysis?.headers) continue

        const modelFields = fieldMeta.fieldsCache.value.get(fileMapping.model)
        if (!modelFields) continue

        const unmappedHeaders = analysis.headers.filter(h => !fileMapping.fieldMappings[h])
        if (unmappedHeaders.length === 0) continue

        const autoMapped = autoMapFields(unmappedHeaders, modelFields)
        if (Object.keys(autoMapped).length > 0) {
          const merged = { ...fileMapping.fieldMappings, ...autoMapped }
          config.setFileMapping(file.name, { ...fileMapping, fieldMappings: merged })
        }
      }

      // Apply sequence
      if (profile.sequence.length > 0) {
        const profileFilenames = profile.sequence
          .filter(s => uploadedFilenames.has(s.filename))
          .map(s => s.filename)
        const profileSet = new Set(profileFilenames)
        const extraFiles = filesStore.files
          .map(f => f.name)
          .filter(name => !profileSet.has(name))
        config.setSequence([...profileFilenames, ...extraFiles])
      }

      // Track missing files
      const allProfileFilenames = new Set(profile.sequence.map(s => s.filename))
      profileMissingFiles.value = new Set(
        [...allProfileFilenames].filter(f => !uploadedFilenames.has(f))
      )

      profileLoadedAt.value = Date.now()
      lastEditAt.value = 0
      await nextTick()
    } catch (e) {
      showAlert(t('config.failedToLoadProfile', { error: (e as Error).message }))
      activeProfile.value = null
    } finally {
      isApplyingProfile.value = false
      profileLoading.value = false
    }
  }

  function clearProfile() {
    activeProfile.value = null
    config.setActiveProfileId(null)
    fieldMeta.transformOverrides.value = new Map()
    profileLoadedAt.value = 0
    lastEditAt.value = 0
    profileMissingFiles.value = new Set()
  }

  function buildProfilePayload() {
    const mappings: ProfileMapping[] = []
    const richMappingsArr: FieldMapping[] = []
    const uploadedFilenames = new Set(filesStore.files.map(f => f.name))

    for (const [filename, mapping] of Object.entries(config.fileMappings)) {
      if (!uploadedFilenames.has(filename)) continue

      const profileMapping: ProfileMapping = { filename, model: mapping.model }
      if (mapping.searchKeys && mapping.searchKeys.length > 0) {
        profileMapping.searchKeys = mapping.searchKeys
      }
      if (mapping.strict !== undefined) {
        profileMapping.strict = mapping.strict
      }
      mappings.push(profileMapping)

      const computedMappings = fieldMeta.buildRichFieldMappings(filename, mapping.fieldMappings)
      richMappingsArr.push(...computedMappings)
    }

    const sequence: ProfileSequenceItem[] = config.importSequence
      .filter(filename => uploadedFilenames.has(filename))
      .map((filename, idx) => ({
        order: idx + 1,
        filename
      }))

    return { mappings, richMappingsArr, sequence }
  }

  function stripVersionSuffix(name: string): string {
    return name.replace(/\s+v\d+(\.\d+)*$/i, '')
  }

  function incrementMinorVersion(version: string): string {
    const parts = version.split('.')
    if (parts.length === 1) return `${parts[0]}.1`
    const minor = parseInt(parts[parts.length - 1], 10) || 0
    parts[parts.length - 1] = String(minor + 1)
    return parts.join('.')
  }

  async function saveAsProfile() {
    let suggestedName = ''
    let suggestedVersion = '1.0'

    if (activeProfile.value) {
      const versionParts = activeProfile.value.version.split('.')
      if (versionParts.length >= 2) {
        const minor = parseInt(versionParts[1], 10) || 0
        suggestedVersion = `${versionParts[0]}.${minor + 1}`
      }
      const baseName = stripVersionSuffix(activeProfile.value.name)
      suggestedName = `${baseName} v${suggestedVersion}`
    }

    const name = await showPrompt(t('config.profileName'), suggestedName)
    if (!name) return

    const { mappings, richMappingsArr, sequence } = buildProfilePayload()

    let target: 'local' | 'server' | undefined
    if (!platform.capabilities.serverProfiles) {
      const saveToServer = await showConfirm(t('config.saveLocationPrompt'))
      target = saveToServer ? 'server' : 'local'
    }

    try {
      const newProfile = await profiles.createProfile({
        name,
        version: suggestedVersion,
        description: activeProfile.value?.description || '',
        odooMinVersion: activeProfile.value?.odooMinVersion,
        mappings,
        sequence,
        runSettings: { ...config.settings },
        fieldMappings: richMappingsArr.length > 0 ? richMappingsArr : undefined
      }, target)

      activeProfile.value = newProfile
      config.setActiveProfileId(newProfile.id)
      profileLoadedAt.value = Date.now()
      lastEditAt.value = 0

      showAlert(target === 'local'
        ? t('config.profileSavedLocal', { name })
        : t('config.profileSavedServer', { name }))
    } catch (e) {
      showAlert(t('config.failedToSaveProfile', { error: (e as Error).message }))
    }
  }

  async function updateExistingProfile() {
    if (!activeProfile.value) return

    const newVersion = incrementMinorVersion(activeProfile.value.version)
    const { mappings, richMappingsArr, sequence } = buildProfilePayload()

    try {
      const updatedProfile = await profiles.updateProfile(activeProfile.value.id, {
        version: newVersion,
        mappings,
        sequence,
        runSettings: { ...config.settings },
        fieldMappings: richMappingsArr.length > 0 ? richMappingsArr : undefined
      })

      activeProfile.value = updatedProfile
      config.setActiveProfileId(updatedProfile.id)
      profileLoadedAt.value = Date.now()
      lastEditAt.value = 0

      showAlert(t('config.profileUpdated', { name: updatedProfile.name, version: updatedProfile.version }))
    } catch (e) {
      showAlert(t('config.failedToSaveProfile', { error: (e as Error).message }))
    }
  }

  return {
    activeProfile,
    profileLoading,
    isApplyingProfile,
    profileMissingFiles,
    hasUnsavedChanges,
    handleProfileSelect,
    clearProfile,
    saveAsProfile,
    updateExistingProfile,
  }
}
