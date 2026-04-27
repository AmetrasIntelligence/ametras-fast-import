<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/files'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { usePlatformStore } from '@/stores/platform'
import { useProfilesStore } from '@/stores/profiles'
import { useRunStore } from '@/stores/run'
import {
  type ImportProfile,
  type ProfileMapping,
  type ProfileSequenceItem
} from '@/types/importProfile'
import { createRunConfig, type RunConfig } from '@/types/runConfig'
import type { FieldMapping, FieldTransform } from '@/types/fieldMapping'
import type { ProfileWizardSeed } from '@/types/profileWizard'
import { useSavedMappingsStore } from '@/stores/savedMappings'
import { fetchModels, fetchModelFields, type OdooModel, type OdooField } from '@/api/odooClient'
import { analyzeCSV } from '@/importer/csvParser'
import { suggestModel } from '@/utils/smartMapping'
import { autoMapFields } from '@/utils/smartFieldMapping'
import { buildFieldLookup, computeFieldMetadata as computeFieldMetadataFromLookup } from '@/utils/fieldMappingMetadata'
import { showAlert, showConfirm } from '@/composables/useDialog'
import { transformRowData } from '@/utils/rowTransform'
import { Button, Card } from '@/ui'
import FileDropZone from '@/components/FileDropZone.vue'
import ModelSelect from '@/components/ModelSelect.vue'
import ModelSuggestion from '@/components/ModelSuggestion.vue'
import ImportSettings from '@/components/ImportSettings.vue'
import FieldMappingTable from '@/components/FieldMappingTable.vue'
import FileList, { type FileListItem } from '@/components/FileList.vue'
import ProfileSelect from '@/components/ProfileSelect.vue'
import ProfileWizardModal from '@/components/ProfileWizardModal.vue'

const { t } = useI18n()
const router = useRouter()
const filesStore = useFilesStore()
const config = useConfigStore()
const session = useSessionStore()
const platform = usePlatformStore()
const savedMappings = useSavedMappingsStore()
const profiles = useProfilesStore()
const run = useRunStore()

// Profile state
const activeProfile = ref<ImportProfile | null>(null)
const runConfig = ref<RunConfig>(createRunConfig(0))
const profileLoading = ref(false)
const configTab = ref<'profile' | 'settings'>('profile')

const models = ref<OdooModel[]>([])
const fieldsCache = ref<Map<string, OdooField[]>>(new Map())
const loading = ref(false)
const loadError = ref<string | null>(null)
const modelSuggestions = ref<Map<string, { model: OdooModel; score: number } | null>>(new Map())
const fieldSuggestionsApplied = ref<Set<string>>(new Set())

// Rich field mappings storage (with required/transform)
const richFieldMappings = ref<Map<string, FieldMapping[]>>(new Map())

// Manual transform overrides: Map<"filename:csvHeader", FieldTransform>
const transformOverrides = ref<Map<string, FieldTransform>>(new Map())

// Track if there are unsaved changes
const profileLoadedAt = ref<number>(0)
const lastEditAt = ref<number>(0)
const isApplyingProfile = ref(false)
const profileMissingFiles = ref<Set<string>>(new Set())
const showProfileWizard = ref(false)
const wizardMode = ref<'create' | 'edit'>('create')
const wizardEditProfile = ref<ImportProfile | null>(null)
const wizardSampleSeed = ref<ProfileWizardSeed | null>(null)
const wizardInitialSource = ref<'scratch' | 'sample' | 'clone'>('scratch')
const wizardInitialCloneProfileId = ref<number | null>(null)

// Mark as edited when config changes
watch(
  () => [
    config.fileMappings,
    config.importSequence,
    config.settings,
    transformOverrides.value.size
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
  // No profile loaded = no "unsaved" state (it's a new config)
  if (!activeProfile.value) return false
  // Edited after profile was loaded
  return lastEditAt.value > profileLoadedAt.value
})

// Navigation guard: warn when leaving with unsaved changes
onBeforeRouteLeave(async (_to, _from) => {
  if (hasUnsavedChanges.value) {
    const confirmed = await showConfirm(t('config.unsavedChangesWarning'))
    if (!confirmed) {
      return false
    }
  }
  return true
})

// Per-file validation state
const validatingFile = ref<string | null>(null)
const validationResults = ref<Map<string, { ok: boolean; message?: string; data?: Record<string, string | number> }>>(new Map())
// Trigger for reactivity - increment when validation results change
const validationTrigger = ref(0)

// Get validation result for a file (reactively tracked via trigger)
function getValidationResult(filename: string) {
  // Access trigger to establish reactivity dependency
  void validationTrigger.value
  return validationResults.value.get(filename)
}

// Files list for FileList component (sorted by import sequence)
const fileListItems = computed<FileListItem[]>(() => {
  const seq = config.importSequence
  return filesStore.files
    .slice()
    .sort((a, b) => {
      const ai = seq.indexOf(a.name)
      const bi = seq.indexOf(b.name)
      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi)
    })
    .map(f => {
      const analysis = filesStore.getAnalysis(f.id)
      return {
        ...f,
        rowCount: analysis?.rowCount,
        headers: analysis?.headers,
        sampleRows: analysis?.sampleRows
      }
    })
})

// Whether we have files selected
const hasFiles = computed(() => filesStore.files.length > 0)

// Compute overall mapping status per file
function getFileStatus(filename: string): 'valid' | 'partial' | 'none' {
  const mapping = config.getFileMapping(filename)
  if (!mapping?.model) return 'none'

  const file = filesStore.files.find(f => f.name === filename)
  const analysis = file ? filesStore.getAnalysis(file.id) : null
  if (!analysis?.headers) return 'valid'

  const mappedCount = Object.keys(mapping.fieldMappings || {}).length
  if (mappedCount === 0) return 'none'
  if (mappedCount < analysis.headers.length) return 'partial'
  return 'valid'
}

const canStartImport = computed(() =>
  filesStore.files.length > 0 &&
  filesStore.files.every(f => {
    const status = getFileStatus(f.name)
    return status !== 'none'
  })
)

const hasPartialMappings = computed(() =>
  filesStore.files.some(f => getFileStatus(f.name) === 'partial')
)

onMounted(async () => {
  loading.value = true
  loadError.value = null
  try {
    models.value = await fetchModels()

    // Load saved mappings and server profiles
    await savedMappings.load()
    await profiles.loadProfiles()

    // Restore active profile from config store (persists across navigation)
    if (config.activeProfileId && !activeProfile.value) {
      try {
        await handleProfileSelect(config.activeProfileId)
      } catch {
        // Profile no longer available, clear the reference
        config.setActiveProfileId(null)
      }
    }

    // Generate model suggestions and restore fields cache for all files
    for (const file of filesStore.files) {
      initMapping(file.name)

      // Restore fields cache for files that already have a model mapped
      const existingMapping = config.getFileMapping(file.name)
      if (existingMapping?.model && !fieldsCache.value.has(existingMapping.model)) {
        try {
          const fields = await fetchModelFields(existingMapping.model)
          fieldsCache.value.set(existingMapping.model, fields)
        } catch {
          // Ignore field fetch errors, user can re-select model
        }
      }

      // Check saved mappings first for suggestions
      const saved = savedMappings.findSuggestion(file.name)
      if (saved) {
        const matchedModel = models.value.find(m => m.model === saved.model)
        if (matchedModel) {
          modelSuggestions.value.set(file.name, { model: matchedModel, score: 100 })
        }
      } else {
        // Smart suggestion
        const analysis = filesStore.getAnalysis(file.id)
        const suggestion = suggestModel(file.name, models.value, undefined, {
          headers: analysis?.headers
        })
        modelSuggestions.value.set(file.name, suggestion)
      }
    }
  } catch (e) {
    loadError.value = t('config.failedToLoadModels', { error: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value = false
  }
})

// File handling functions (from FilesView)
async function selectFiles() {
  const selected = await window.api.files.select()
  await addAndAnalyze(selected)
}

async function addAndAnalyze(selected: Array<{ id: string; name: string; size: number }>) {
  filesStore.addFiles(selected)

  for (const file of selected) {
    const analysis = await analyzeCSV(file.id)
    filesStore.setAnalysis(file.id, analysis)

    // Initialize mapping and generate suggestions for new files
    initMapping(file.name)

    // Check saved mappings first for suggestions
    const saved = savedMappings.findSuggestion(file.name)
    if (saved) {
      const matchedModel = models.value.find(m => m.model === saved.model)
      if (matchedModel) {
        modelSuggestions.value.set(file.name, { model: matchedModel, score: 100 })
      }
    } else {
      // Smart suggestion
      const analysis = filesStore.getAnalysis(file.id)
      const suggestion = suggestModel(file.name, models.value, undefined, {
        headers: analysis?.headers
      })
      modelSuggestions.value.set(file.name, suggestion)
    }
  }

  config.setSequence(filesStore.files.map(f => f.name))
}

async function handleDrop(files: File[]) {
  // Use webUtils.getPathForFile for sandbox-compatible file path access
  const paths = files
    .map(f => {
      try {
        return window.api.files.getPathForFile(f)
      } catch {
        return null
      }
    })
    .filter((p): p is string => !!p)

  if (paths.length === 0) {
    // Fallback to file dialog if paths not available (browser mode)
    selectFiles()
    return
  }

  const selected = await window.api.files.register(paths)
  await addAndAnalyze(selected)
}

function initMapping(filename: string) {
  if (!config.getFileMapping(filename)) {
    config.setFileMapping(filename, {
      filename,
      model: '',
      fieldMappings: {}
    })
  }
}

// Get fields for a specific file's model
function getFieldsForFile(filename: string): OdooField[] {
  const mapping = config.getFileMapping(filename)
  if (!mapping?.model) return []
  return fieldsCache.value.get(mapping.model) || []
}

// Build field lookup for a file
function getFieldLookup(filename: string): Map<string, OdooField> {
  return buildFieldLookup(getFieldsForFile(filename))
}

// Build set of all valid Odoo field values for a model (mirrors FieldSelect's allOptions)
function buildValidFieldValues(fields: OdooField[]): Set<string> {
  const valid = new Set<string>(['id', '.id'])
  for (const f of fields) {
    if (f.readonly) continue
    valid.add(f.name)
    if (f.type === 'many2one' || f.type === 'many2many') {
      valid.add(`${f.name}/id`)
      valid.add(`${f.name}/.id`)
    }
  }
  return valid
}

async function selectModelForFile(filename: string, model: string) {
  // Reset field suggestions flag so auto-mapping runs for the new model
  fieldSuggestionsApplied.value.delete(filename)

  const mapping = config.getFileMapping(filename)
  if (mapping) {
    config.setFileMapping(filename, { ...mapping, model, fieldMappings: {} })
  }

  if (!fieldsCache.value.has(model)) {
    const fields = await fetchModelFields(model)
    fieldsCache.value.set(model, fields)
  }

  // Auto-suggest field mappings
  const file = filesStore.files.find(f => f.name === filename)
  const analysis = file ? filesStore.getAnalysis(file.id) : null
  const fields = fieldsCache.value.get(model)
  if (analysis && fields && !fieldSuggestionsApplied.value.has(filename)) {
    const suggestions = autoMapFields(analysis.headers, fields)
    if (Object.keys(suggestions).length > 0 && mapping) {
      config.setFileMapping(filename, { ...mapping, model, fieldMappings: suggestions })
      fieldSuggestionsApplied.value.add(filename)
    }
  }

  // Save mapping for future use
  savedMappings.addMapping(filename, model)
}

function updateFieldMappingForFile(filename: string, csvHeader: string, odooField: string) {
  const mapping = config.getFileMapping(filename)
  if (!mapping) return

  const fieldMappings = { ...mapping.fieldMappings }
  if (odooField) {
    fieldMappings[csvHeader] = odooField
  } else {
    delete fieldMappings[csvHeader]
  }
  config.setFileMapping(filename, { ...mapping, fieldMappings })

  // Update rich mappings
  updateRichMappingForFile(filename, csvHeader, odooField)
}

function updateRichMappingForFile(filename: string, csvHeader: string, odooField: string) {
  const stored = richFieldMappings.value.get(filename) || []
  const idx = stored.findIndex(m => m.csvHeader === csvHeader)

  if (!odooField) {
    if (idx >= 0) {
      stored.splice(idx, 1)
      richFieldMappings.value.set(filename, stored)
    }
    // Also clear transform override
    transformOverrides.value.delete(`${filename}:${csvHeader}`)
    return
  }

  const { transform: autoTransform, required } = computeFieldMetadataForFile(filename, csvHeader, odooField)

  // Use manual override if available
  const overrideKey = `${filename}:${csvHeader}`
  const transform = transformOverrides.value.get(overrideKey) ?? autoTransform

  const newMapping: FieldMapping = {
    filename,
    csvHeader,
    odooField,
    required,
    transform
  }

  if (idx >= 0) {
    stored[idx] = newMapping
  } else {
    stored.push(newMapping)
  }
  richFieldMappings.value.set(filename, stored)
}

function computeFieldMetadataForFile(filename: string, csvHeader: string, odooField: string): { transform: FieldTransform; required: boolean } {
  return computeFieldMetadataFromLookup(csvHeader, odooField, getFieldLookup(filename))
}

function updateTransformForFile(filename: string, csvHeader: string, transform: FieldTransform) {
  const overrideKey = `${filename}:${csvHeader}`
  transformOverrides.value.set(overrideKey, transform)

  // Also update rich mappings
  updateRichMappingForFile(filename, csvHeader, config.getFileMapping(filename)?.fieldMappings[csvHeader] || '')
}

async function validateRowForFile(filename: string) {

  if (!platform.capabilities.rowValidation) {
    validationResults.value.set(filename, {
      ok: false,
      message: t('config.validationNotAvailable')
    })
    return
  }

  const mapping = config.getFileMapping(filename)
  const file = filesStore.files.find(f => f.name === filename)
  const analysis = file ? filesStore.getAnalysis(file.id) : null

  if (!mapping?.model || !analysis?.sampleRows?.length || !session.baseUrl) return

  validatingFile.value = filename
  validationResults.value.delete(filename)
  validationTrigger.value++

  try {
    // Pick a random row from sample rows
    const randomIndex = Math.floor(Math.random() * analysis.sampleRows.length)
    const row = analysis.sampleRows[randomIndex]
    const mappedData = transformRowData(row, mapping.fieldMappings)

    // Detect if using external ID for upsert
    const useExternalId = '__external_id__' in mappedData

    const result = await window.api.odoo.call<{ results: Array<{ ok: boolean; action?: string; error?: string }> }>({
      baseUrl: session.baseUrl,
      db: session.currentServer?.db,
      endpoint: '/ametras_fast_import/run',
      params: {
        model: mapping.model,
        rows: [mappedData],
        use_external_id: useExternalId,
        dry_run: true
      }
    })

    const rowNum = randomIndex + 2 // +1 for 0-index, +1 for header row
    if (result.ok && result.result?.results?.length) {
      const rowResult = result.result.results[0]
      validationResults.value.set(filename, {
        ok: rowResult.ok,
        message: rowResult.ok
          ? t('config.validationRowSuccess', { row: rowNum, action: rowResult.action || 'processed' })
          : t('config.validationRowError', { row: rowNum, error: rowResult.error || t('config.validationFailed') }),
        data: mappedData
      })
    } else if (result.ok) {
      validationResults.value.set(filename, { ok: true, message: t('config.validationDryRunOk', { row: rowNum }), data: mappedData })
    } else {
      validationResults.value.set(filename, { ok: false, message: t('config.validationRequestFailed', { row: rowNum, error: result.error || t('config.validationFailed') }), data: mappedData })
    }
  } catch (e) {
    validationResults.value.set(filename, {
      ok: false,
      message: e instanceof Error ? e.message : t('config.validationFailed')
    })
  } finally {
    validatingFile.value = null
    validationTrigger.value++
  }
}

function handleReorder(filenames: string[]) {
  config.setSequence(filenames)
}

function toggleStrictForFile(filename: string, strict: boolean) {
  const mapping = config.getFileMapping(filename)
  if (mapping) {
    config.setFileMapping(filename, { ...mapping, strict })
  }
}

async function removeAllFiles() {
  const confirmed = await showConfirm(t('files.removeAllConfirm'))
  if (!confirmed) return

  filesStore.clearAll()
  config.clearFileMappings()
  config.setSequence([])
  richFieldMappings.value = new Map()
  transformOverrides.value = new Map()
  modelSuggestions.value = new Map()
  fieldSuggestionsApplied.value = new Set()
  validationResults.value = new Map()
  validationTrigger.value++
}

function removeFile(fileId: string) {
  // Find the filename before removing from store
  const file = filesStore.files.find(f => f.id === fileId)
  const filename = file?.name

  filesStore.removeFile(fileId)
  // Preserve existing sequence order — only remove the deleted file
  config.setSequence(
    filename
      ? config.importSequence.filter(f => f !== filename)
      : filesStore.files.map(f => f.name)
  )

  // Clean up mappings for removed file
  if (filename) {
    config.removeFileMapping(filename)

    // Clean up rich field mappings
    if (richFieldMappings.value.has(filename)) {
      const newMap = new Map(richFieldMappings.value)
      newMap.delete(filename)
      richFieldMappings.value = newMap
    }

    // Clean up validation results
    if (validationResults.value.has(filename)) {
      const newResults = new Map(validationResults.value)
      newResults.delete(filename)
      validationResults.value = newResults
      validationTrigger.value++
    }

    // Clean up model suggestions
    if (modelSuggestions.value.has(filename)) {
      const newSuggestions = new Map(modelSuggestions.value)
      newSuggestions.delete(filename)
      modelSuggestions.value = newSuggestions
    }

    // Clean up field suggestions applied
    fieldSuggestionsApplied.value.delete(filename)
  }
}

// Profile handlers
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
    runConfig.value = createRunConfig(profile.id)
    config.setSettings({ ...profile.runSettings })

    // Get set of uploaded filenames for filtering
    const uploadedFilenames = new Set(filesStore.files.map(f => f.name))

    // Apply file mappings from profile
    for (const mapping of profile.mappings) {
      // Only apply mapping if file is uploaded
      if (!uploadedFilenames.has(mapping.filename)) continue

      const existing = config.getFileMapping(mapping.filename)
      config.setFileMapping(mapping.filename, {
        filename: mapping.filename,
        model: mapping.model,
        fieldMappings: existing?.fieldMappings || {},
        searchKeys: mapping.searchKeys,
        strict: mapping.strict
      })

      // Load fields for the model
      if (mapping.model && !fieldsCache.value.has(mapping.model)) {
        const fields = await fetchModelFields(mapping.model)
        fieldsCache.value.set(mapping.model, fields)
      }
    }

    // Apply rich field mappings (csvHeader format with required/transform)
    const newRichMappings = new Map<string, FieldMapping[]>()
    const newTransformOverrides = new Map<string, FieldTransform>()

    if (profile.richFieldMappings && profile.richFieldMappings.length > 0) {
      for (const fm of profile.richFieldMappings) {
        if (!uploadedFilenames.has(fm.filename)) continue

        // Validate: only apply if the target field exists on this server
        const fileMapping = config.getFileMapping(fm.filename)
        const modelFields = fileMapping?.model ? fieldsCache.value.get(fileMapping.model) : null
        if (modelFields) {
          const validFields = buildValidFieldValues(modelFields)
          if (!validFields.has(fm.odooField)) continue
        }

        // Also apply to config.fileMappings for the actual import
        const existing = config.getFileMapping(fm.filename)
        if (existing) {
          const fieldMappings = { ...existing.fieldMappings, [fm.csvHeader]: fm.odooField }
          config.setFileMapping(fm.filename, { ...existing, fieldMappings })
        }

        // Store in richFieldMappings for UI display
        if (!newRichMappings.has(fm.filename)) {
          newRichMappings.set(fm.filename, [])
        }
        newRichMappings.get(fm.filename)!.push(fm)

        // Restore transform overrides from profile
        if (fm.transform && fm.transform.type !== 'passthrough') {
          newTransformOverrides.set(`${fm.filename}:${fm.csvHeader}`, fm.transform)
        }
      }
    }

    richFieldMappings.value = newRichMappings
    transformOverrides.value = newTransformOverrides

    // After profile mappings are applied, auto-map any remaining unmapped headers
    for (const file of filesStore.files) {
      const fileMapping = config.getFileMapping(file.name)
      if (!fileMapping?.model) continue

      const analysis = filesStore.getAnalysis(file.id)
      if (!analysis?.headers) continue

      const modelFields = fieldsCache.value.get(fileMapping.model)
      if (!modelFields) continue

      const unmappedHeaders = analysis.headers.filter(h => !fileMapping.fieldMappings[h])
      if (unmappedHeaders.length === 0) continue

      const autoMapped = autoMapFields(unmappedHeaders, modelFields)
      if (Object.keys(autoMapped).length > 0) {
        const merged = { ...fileMapping.fieldMappings, ...autoMapped }
        config.setFileMapping(file.name, { ...fileMapping, fieldMappings: merged })
      }
    }

    // Apply sequence: use profile order for known files, append any
    // uploaded files not in the profile so they don't get silently skipped.
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

    // Track files referenced by profile but not currently uploaded
    const allProfileFilenames = new Set(profile.sequence.map(s => s.filename))
    profileMissingFiles.value = new Set(
      [...allProfileFilenames].filter(f => !uploadedFilenames.has(f))
    )

    // Mark as freshly loaded (no unsaved changes yet)
    profileLoadedAt.value = Date.now()
    lastEditAt.value = 0
    await nextTick() // flush queued watchers (guarded by isApplyingProfile)
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
  runConfig.value = createRunConfig(0)
  transformOverrides.value = new Map()
  profileLoadedAt.value = 0
  lastEditAt.value = 0
  profileMissingFiles.value = new Set()
}

async function proceed() {
  if (hasPartialMappings.value) {
    const partialFiles = filesStore.files
      .filter(f => getFileStatus(f.name) === 'partial')
      .map(f => f.name)
    const ok = await showConfirm(t('config.unmappedFieldsWarning', { count: partialFiles.length, files: partialFiles.join(', ') }))
    if (!ok) return
  }
  // Reset the run store before starting a new import
  run.reset()
  router.push('/run')
}

/**
 * Build rich field mappings with proper required and transform values.
 * This ensures all field metadata is computed from actual field definitions.
 */
function buildRichFieldMappings(filename: string, fieldMappingsRecord: Record<string, string>): FieldMapping[] {
  const result: FieldMapping[] = []

  for (const [csvHeader, odooField] of Object.entries(fieldMappingsRecord)) {
    // Always compute transform and required from field metadata
    const { transform, required } = computeFieldMetadataForFile(filename, csvHeader, odooField)

    result.push({
      filename,
      csvHeader,
      odooField,
      required,
      transform
    })
  }

  return result
}

/**
 * Build profile mapping payload from current config.
 */
function buildProfileMappingsPayload() {
  const mappings: ProfileMapping[] = []
  const richMappingsArr: FieldMapping[] = []

  // Only include files that are currently uploaded
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

    const computedMappings = buildRichFieldMappings(filename, mapping.fieldMappings)
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

function buildSampleSeedFromCurrentConfig(): ProfileWizardSeed | null {
  if (filesStore.files.length === 0) return null

  const { mappings, richMappingsArr, sequence } = buildProfileMappingsPayload()
  const samples = filesStore.files
    .map(file => ({
      filename: file.name,
      headers: filesStore.getAnalysis(file.id)?.headers || []
    }))
    .filter(sample => sample.headers.length > 0)

  return {
    name: activeProfile.value?.name || '',
    version: activeProfile.value?.version || '1.0',
    description: activeProfile.value?.description || '',
    odooMinVersion: activeProfile.value?.odooMinVersion,
    mappings,
    sequence,
    runSettings: { ...config.settings },
    richFieldMappings: richMappingsArr.length > 0 ? richMappingsArr : undefined,
    samples: samples.length > 0 ? samples : undefined
  }
}

function openCreateProfileWizard(initialSource: 'scratch' | 'sample' | 'clone' = 'scratch', cloneProfileId: number | null = null) {
  wizardMode.value = 'create'
  wizardEditProfile.value = null
  wizardSampleSeed.value = buildSampleSeedFromCurrentConfig()
  wizardInitialSource.value = initialSource === 'sample' && !wizardSampleSeed.value
    ? 'scratch'
    : initialSource
  wizardInitialCloneProfileId.value = cloneProfileId
  showProfileWizard.value = true
}

async function openEditProfileWizard() {
  if (!activeProfile.value) return
  try {
    wizardMode.value = 'edit'
    wizardSampleSeed.value = null
    wizardInitialSource.value = 'scratch'
    wizardInitialCloneProfileId.value = null
    wizardEditProfile.value = await profiles.loadProfile(activeProfile.value.id)
    showProfileWizard.value = true
  } catch (e) {
    showAlert(t('profileWizard.failedToLoadEdit', { error: (e as Error).message }))
  }
}

function closeProfileWizard() {
  showProfileWizard.value = false
}

async function handleProfileWizardSaved(profile: ImportProfile) {
  await profiles.loadProfiles(true)
  activeProfile.value = profile
  config.setActiveProfileId(profile.id)
  runConfig.value = createRunConfig(profile.id)
  profileLoadedAt.value = Date.now()
  lastEditAt.value = 0
  showProfileWizard.value = false

  if (wizardMode.value === 'create') {
    showAlert(t('profileWizard.createdSuccess', { name: profile.name }))
  } else {
    showAlert(t('profileWizard.updatedSuccess', { name: profile.name }))
  }
}
</script>

<template>
  <div class="p-4 d-flex flex-column gap-4">
    <div class="d-flex justify-content-between align-items-center">
      <h1 class="fs-4 fw-semibold mb-0">{{ $t('nav.import') }}</h1>
      <div class="d-flex gap-2 align-items-center">
        <small v-if="activeProfile" :class="hasUnsavedChanges ? 'text-warning' : 'text-body-secondary'">
          {{ activeProfile.name }} v{{ activeProfile.version }}
          <span v-if="hasUnsavedChanges" class="csv-edited-badge">{{ $t('config.edited') }}</span>
        </small>
        <Button
          variant="outline"
          size="sm"
          @click="openCreateProfileWizard(hasFiles ? 'sample' : 'scratch')"
        >
          {{ $t('config.createProfile') }}
        </Button>
        <Button
          v-if="activeProfile"
          variant="outline"
          size="sm"
          @click="openEditProfileWizard"
        >
          {{ $t('config.editProfile') }}
        </Button>
      </div>
    </div>

    <div v-if="loadError" class="alert alert-danger py-2 small mb-0">
      {{ loadError }}
    </div>

    <!-- Show drop zone only when no files yet -->
    <FileDropZone
      v-if="!hasFiles"
      @files-dropped="handleDrop"
      @browse="selectFiles"
    />

    <!-- Show config sections only when files are selected -->
    <template v-if="hasFiles">
      <!-- Profile & Settings Section -->
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="small fw-semibold">{{ $t('config.serverProfile') }}</span>
      </div>
      <Card class="csv-import-card">
        <div class="csv-import-card__tabs">
          <button
            type="button"
            class="csv-import-card__tab"
            :class="{ 'csv-import-card__tab--active': configTab === 'profile' }"
            @click="configTab = 'profile'"
          >
            {{ $t('config.tabs.profile') }}
          </button>
          <button
            type="button"
            class="csv-import-card__tab"
            :class="{ 'csv-import-card__tab--active': configTab === 'settings' }"
            @click="configTab = 'settings'"
          >
            {{ $t('config.tabs.settings') }}
          </button>
        </div>
        <div v-show="configTab === 'profile'" class="csv-import-card__content">
          <ProfileSelect
            :model-value="activeProfile?.id ?? null"
            :profiles="profiles.profileList"
            :loading="profiles.loading"
            @update:model-value="handleProfileSelect($event ?? 0)"
          />
          <div v-if="profileLoading" class="small text-body-secondary mt-2">{{ $t('config.loadingProfileData') }}</div>
        </div>
        <div v-show="configTab === 'settings'" class="csv-import-card__content">
          <ImportSettings />
        </div>
      </Card>

      <!-- Draggable File List -->
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="small fw-semibold">{{ $t('config.fileListTitle') }}</span>
        <div class="d-flex align-items-center gap-2">
          <small class="text-body-secondary">{{ fileListItems.length }} {{ $t('common.files', fileListItems.length) }}</small>
          <Button variant="ghost" size="sm" @click="removeAllFiles">
            {{ $t('files.removeAll') }}
          </Button>
        </div>
      </div>

      <FileList
        :files="fileListItems"
        :missing-files="[...profileMissingFiles]"
        @reorder="handleReorder"
        @remove="removeFile"
        @dismiss-missing="profileMissingFiles.delete($event)"
      >
        <template #expanded="{ file }">
          <div class="d-flex flex-column gap-3">
            <!-- 1. CSV Preview -->
            <div v-if="file.headers?.length" class="csv-config-section">
              <div class="csv-config-section__header">
                <span>{{ $t('config.csvPreview') }}</span>
                <small class="text-body-secondary">
                  {{ file.headers.length }} {{ $t('common.columns', file.headers.length) }} · {{ file.rowCount?.toLocaleString() || '?' }} {{ $t('common.rows', 2) }}
                </small>
              </div>
              <div class="csv-preview__scroll">
                <table class="csv-preview__table">
                  <thead>
                    <tr>
                      <th v-for="h in file.headers" :key="h">{{ h }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, idx) in (file.sampleRows || []).slice(0, 4)" :key="idx">
                      <td v-for="h in file.headers" :key="h">{{ row[h] ?? '' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 2. Model Selection -->
            <div class="csv-config-section">
              <div class="csv-config-section__header">
                <span>{{ $t('config.targetModel') }}</span>
              </div>

              <ModelSuggestion
                v-if="modelSuggestions.get(file.name) && !config.getFileMapping(file.name)?.model"
                :suggestion="modelSuggestions.get(file.name) ?? null"
                :current-model="config.getFileMapping(file.name)?.model || null"
                @accept="selectModelForFile(file.name, $event)"
              />

              <ModelSelect
                :model-value="config.getFileMapping(file.name)?.model || null"
                @update:model-value="selectModelForFile(file.name, $event)"
              />
            </div>

            <!-- 3. Field Mappings -->
            <FieldMappingTable
              v-if="config.getFileMapping(file.name)?.model && file.headers?.length"
              :headers="file.headers"
              :field-mappings="config.getFileMapping(file.name)?.fieldMappings || {}"
              :fields="getFieldsForFile(file.name)"
              :strict="config.getFileMapping(file.name)?.strict ?? true"
              :hide-strict="!platform.capabilities.searchKeys"
              :get-field-lookup="() => getFieldLookup(file.name)"
              @update:field-mapping="(header: string, field: string) => updateFieldMappingForFile(file.name, header, field)"
              @update:transform="(header: string, transform: any) => updateTransformForFile(file.name, header, transform)"
              @update:strict="toggleStrictForFile(file.name, $event)"
            />

            <!-- 4. Validate Button -->
            <div v-if="config.getFileMapping(file.name)?.model && Object.keys(config.getFileMapping(file.name)?.fieldMappings || {}).length > 0" class="csv-config-section">
              <Button
                variant="outline"
                size="sm"
                :disabled="validatingFile === file.name"
                @click="validateRowForFile(file.name)"
              >
                {{ validatingFile === file.name ? $t('config.validating') : $t('config.validateRow') }}
              </Button>

              <div
                v-if="getValidationResult(file.name)"
                class="csv-validation-result"
                :class="getValidationResult(file.name)!.ok ? 'csv-validation-result--ok' : 'csv-validation-result--error'"
              >
                <div class="csv-validation-result__header">
                  {{ getValidationResult(file.name)!.ok ? '✓ ' + $t('config.validationPassed') : '✗ ' + $t('config.validationFailed') }}
                </div>
                <div v-if="getValidationResult(file.name)!.message" class="csv-validation-result__message">
                  {{ getValidationResult(file.name)!.message }}
                </div>
                <div v-if="getValidationResult(file.name)!.data" class="csv-validation-result__data">
                  <pre>{{ JSON.stringify(getValidationResult(file.name)!.data, null, 2) }}</pre>
                </div>
              </div>
            </div>
          </div>
        </template>
      </FileList>

      <!-- Drop zone for adding more files (compact mode) -->
      <FileDropZone
        compact
        @files-dropped="handleDrop"
        @browse="selectFiles"
      />

      <div class="d-flex justify-content-end">
        <Button
          :disabled="!canStartImport"
          @click="proceed"
        >
          {{ $t('config.startImport') }}
        </Button>
      </div>
    </template>

    <ProfileWizardModal
      :open="showProfileWizard"
      :mode="wizardMode"
      :edit-profile="wizardEditProfile"
      :sample-seed="wizardSampleSeed"
      :allow-sample="wizardSampleSeed !== null"
      :initial-source="wizardInitialSource"
      :initial-clone-profile-id="wizardInitialCloneProfileId"
      @close="closeProfileWizard"
      @saved="handleProfileWizardSaved"
    />
  </div>
</template>

<style scoped>
/* Edited indicator */
.csv-edited-badge {
  display: inline-block;
  margin-left: 0.25rem;
  padding: 0.125rem 0.375rem;
  font-size: 0.65rem;
  font-weight: 500;
  background: var(--bs-warning-bg-subtle);
  color: var(--bs-warning-text-emphasis);
  border-radius: var(--bs-border-radius-sm);
}

/* Import card with tabs (profile/settings) */
.csv-import-card {
  overflow: hidden;
}
.csv-import-card__tabs {
  display: flex;
  border-bottom: 1px solid var(--bs-border-color);
  background: var(--bs-tertiary-bg);
}
.csv-import-card__tab {
  position: relative;
  padding: 0.5rem 1rem;
  border: none;
  background: none;
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
  color: var(--bs-secondary-color);
  border-bottom: 2px solid transparent;
}
.csv-import-card__tab:hover {
  color: var(--bs-body-color);
  background: var(--bs-secondary-bg-subtle);
}
.csv-import-card__tab--active {
  color: var(--bs-primary);
  border-bottom-color: var(--bs-primary);
}
.csv-import-card__content {
  padding: 0.75rem;
}

/* Config sections inside expanded file area */
.csv-config-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.csv-config-section__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--bs-body-color);
}

/* CSV Preview */
.csv-preview__scroll {
  overflow-x: auto;
  max-width: 100%;
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
}
.csv-preview__table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 0.7rem;
  font-family: ui-monospace, monospace;
}
.csv-preview__table th {
  padding: 0.25rem 0.5rem;
  text-align: left;
  font-weight: 600;
  color: var(--bs-body-color);
  background: var(--bs-tertiary-bg);
  border-bottom: 1px solid var(--bs-border-color);
  white-space: nowrap;
}
.csv-preview__table td {
  padding: 0.2rem 0.5rem;
  color: var(--bs-secondary-color);
  border-bottom: 1px solid var(--bs-border-color-translucent);
  white-space: nowrap;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Validation result */
.csv-validation-result {
  margin-top: 0.5rem;
  padding: 0.5rem;
  border-radius: var(--bs-border-radius);
  font-size: 0.75rem;
}
.csv-validation-result--ok {
  background: var(--bs-success-bg-subtle);
  border: 1px solid var(--bs-success-border-subtle);
}
.csv-validation-result--error {
  background: var(--bs-danger-bg-subtle);
  border: 1px solid var(--bs-danger-border-subtle);
}
.csv-validation-result__header {
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.csv-validation-result--ok .csv-validation-result__header {
  color: var(--bs-success-text-emphasis);
}
.csv-validation-result--error .csv-validation-result__header {
  color: var(--bs-danger-text-emphasis);
}
.csv-validation-result__message {
  color: var(--bs-body-color);
  margin-bottom: 0.375rem;
}
.csv-validation-result__data {
  background: var(--bs-body-bg);
  border-radius: var(--bs-border-radius-sm);
  padding: 0.375rem;
  overflow-x: auto;
}
.csv-validation-result__data pre {
  margin: 0;
  font-size: 0.65rem;
  font-family: ui-monospace, monospace;
  color: var(--bs-secondary-color);
}
</style>
