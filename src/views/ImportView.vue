<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/files'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { useProfilesStore } from '@/stores/profiles'
import { useRunStore } from '@/stores/run'
import {
  type ImportProfile,
  type ProfileMapping,
  type ProfileSequenceItem
} from '@/types/importProfile'
import { createRunConfig, type RunConfig } from '@/types/runConfig'
import type { FieldMapping, FieldTransform } from '@/types/fieldMapping'
import { STANDARD_DB_ID_MODELS } from '@/types/fieldMapping'
import { useSavedMappingsStore } from '@/stores/savedMappings'
import { fetchModels, fetchModelFields, type OdooModel, type OdooField } from '@/api/odooClient'
import { analyzeCSV } from '@/importer/csvParser'
import { suggestModel } from '@/utils/smartMapping'
import { autoMapFields } from '@/utils/smartFieldMapping'
import { showAlert, showConfirm, showPrompt } from '@/composables/useDialog'
import { Button, Card } from '@/ui'
import FileDropZone from '@/components/FileDropZone.vue'
import ModelSelect from '@/components/ModelSelect.vue'
import ModelSuggestion from '@/components/ModelSuggestion.vue'
import ImportSettings from '@/components/ImportSettings.vue'
import FieldSelect from '@/components/FieldSelect.vue'
import FileList, { type FileListItem } from '@/components/FileList.vue'
import ProfileSelect from '@/components/ProfileSelect.vue'
import TransformSelect from '@/components/TransformSelect.vue'

const { t } = useI18n()
const router = useRouter()
const filesStore = useFilesStore()
const config = useConfigStore()
const session = useSessionStore()
const savedMappings = useSavedMappingsStore()
const profiles = useProfilesStore()
const run = useRunStore()

// Profile state
const activeProfile = ref<ImportProfile | null>(null)
const runConfig = ref<RunConfig>(createRunConfig(0))
const profileLoading = ref(false)

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

// Mark as edited when config changes
watch(
  () => [
    config.fileMappings,
    config.importSequence,
    config.settings,
    transformOverrides.value.size
  ],
  () => {
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
const validationResults = ref<Map<string, { ok: boolean; message?: string; data?: Record<string, unknown> }>>(new Map())
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
    profiles.loadProfiles()

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
        modelSuggestions.value.set(file.name, {
          model: models.value.find(m => m.model === saved.model)!,
          score: 100
        })
      } else {
        // Smart suggestion
        const suggestion = suggestModel(file.name, models.value)
        modelSuggestions.value.set(file.name, suggestion)
      }
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Failed to load models'
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
      modelSuggestions.value.set(file.name, {
        model: models.value.find(m => m.model === saved.model)!,
        score: 100
      })
    } else {
      // Smart suggestion
      const suggestion = suggestModel(file.name, models.value)
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
  const map = new Map<string, OdooField>()
  for (const f of getFieldsForFile(filename)) {
    map.set(f.name, f)
  }
  return map
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
  const baseName = odooField.endsWith('/.id')
    ? odooField.slice(0, -4)
    : odooField.endsWith('/id')
      ? odooField.slice(0, -3)
      : odooField

  const fieldLookup = getFieldLookup(filename)
  const field = fieldLookup.get(baseName)
  const isRelational = field?.type === 'many2one' || field?.type === 'many2many'

  let transform: FieldTransform = { type: 'passthrough' }
  let required = field?.required ?? false

  if (odooField.endsWith('/id') && isRelational && field?.relation) {
    transform = field.type === 'many2many'
      ? { type: 'm2m_ref', model: field.relation }
      : { type: 'm2o_ref', model: field.relation }
  } else if (odooField.endsWith('/.id') && isRelational && field?.relation) {
    transform = { type: 'db_id', model: field.relation }
  }

  if (csvHeader === 'id' || odooField === 'id') {
    required = true
  }

  return { transform, required }
}

function getMappingInfoForFile(filename: string, csvHeader: string): { transform: FieldTransform; required: boolean; isStandardDbId: boolean } | null {
  const mapping = config.getFileMapping(filename)
  if (!mapping?.fieldMappings[csvHeader]) return null

  const odooField = mapping.fieldMappings[csvHeader]
  const { transform: autoTransform, required } = computeFieldMetadataForFile(filename, csvHeader, odooField)

  // Check for manual override
  const overrideKey = `${filename}:${csvHeader}`
  const transform = transformOverrides.value.get(overrideKey) ?? autoTransform

  const isStandardDbId = transform.type === 'db_id' && STANDARD_DB_ID_MODELS.has(transform.model)

  return { transform, required, isStandardDbId }
}

function getFieldInfoForMapping(filename: string, csvHeader: string): { fieldType?: string; relationModel?: string } {
  const mapping = config.getFileMapping(filename)
  if (!mapping?.fieldMappings[csvHeader]) return {}

  const odooField = mapping.fieldMappings[csvHeader]
  const baseName = odooField.endsWith('/.id')
    ? odooField.slice(0, -4)
    : odooField.endsWith('/id')
      ? odooField.slice(0, -3)
      : odooField

  const fieldLookup = getFieldLookup(filename)
  const field = fieldLookup.get(baseName)

  return {
    fieldType: field?.type,
    relationModel: field?.relation
  }
}

function updateTransformForFile(filename: string, csvHeader: string, transform: FieldTransform) {
  const overrideKey = `${filename}:${csvHeader}`
  transformOverrides.value.set(overrideKey, transform)

  // Also update rich mappings
  updateRichMappingForFile(filename, csvHeader, config.getFileMapping(filename)?.fieldMappings[csvHeader] || '')
}

async function validateRowForFile(filename: string) {
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
    const mappedData: Record<string, unknown> = {}

    for (const [csvHeader, odooField] of Object.entries(mapping.fieldMappings)) {
      const value = row[csvHeader]
      if (value === undefined || value === '') continue

      // Match batchExecutor.transformRow logic exactly

      // Handle id/.id fields specially for upsert
      // Any CSV column can be mapped to 'id' (external ID) or '.id' (database ID)
      if (odooField === 'id') {
        mappedData['__external_id__'] = value
        continue
      }
      if (odooField === '.id') {
        mappedData['id'] = parseInt(value, 10)
        continue
      }

      // Old implementation (fallback - only works if CSV column is literally named 'id' or '.id'):
      // if (csvHeader === 'id' && odooField === 'id') {
      //   mappedData['__external_id__'] = value
      //   continue
      // }
      // if (csvHeader === '.id' && odooField === '.id') {
      //   mappedData['id'] = parseInt(value, 10)
      //   continue
      // }

      // Handle reference suffixes: /.id for database ID, /id for external ID
      if (odooField.endsWith('/.id')) {
        const targetField = odooField.slice(0, -4)
        mappedData[targetField] = parseInt(value, 10)
        continue
      }
      if (odooField.endsWith('/id')) {
        const targetField = odooField.slice(0, -3)
        mappedData[targetField] = value
        continue
      }

      mappedData[odooField] = value
    }

    // Detect if using external ID for upsert (matches batchExecutor.detectIdColumn)
    // Check if ANY field is mapped to 'id' or '.id'
    const useExternalId = '__external_id__' in mappedData

    // Old implementation (fallback):
    // const hasExternalId = mapping.fieldMappings['id'] === 'id'
    // const hasDbId = mapping.fieldMappings['.id'] === '.id'
    // const useExternalId = hasExternalId || (!hasDbId && '__external_id__' in mappedData)

    const result = await window.api.odoo.call<{ results: Array<{ ok: boolean; action?: string; error?: string }> }>({
      baseUrl: session.baseUrl,
      db: session.currentServer?.db,
      endpoint: '/csv_import/run',
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
          ? `Row ${rowNum} would be ${rowResult.action || 'processed'} successfully`
          : `Row ${rowNum}: ${rowResult.error || 'Validation failed'}`,
        data: mappedData
      })
    } else if (result.ok) {
      validationResults.value.set(filename, { ok: true, message: `Row ${rowNum}: Dry run completed`, data: mappedData })
    } else {
      validationResults.value.set(filename, { ok: false, message: `Row ${rowNum}: ${result.error || 'Request failed'}`, data: mappedData })
    }
  } catch (e) {
    validationResults.value.set(filename, {
      ok: false,
      message: e instanceof Error ? e.message : 'Validation failed'
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

function removeFile(fileId: string) {
  // Find the filename before removing from store
  const file = filesStore.files.find(f => f.id === fileId)
  const filename = file?.name

  filesStore.removeFile(fileId)
  config.setSequence(filesStore.files.map(f => f.name))

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
  try {
    const profile = await profiles.loadProfile(id)
    activeProfile.value = profile
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

    // Apply sequence (only for uploaded files)
    if (profile.sequence.length > 0) {
      const filteredSequence = profile.sequence
        .filter(s => uploadedFilenames.has(s.filename))
        .map(s => s.filename)
      config.setSequence(filteredSequence)
    }

    // Mark as freshly loaded (no unsaved changes yet)
    profileLoadedAt.value = Date.now()
    lastEditAt.value = 0
  } catch (e) {
    showAlert(`Failed to load profile: ${(e as Error).message}`)
    activeProfile.value = null
  } finally {
    profileLoading.value = false
  }
}

function clearProfile() {
  activeProfile.value = null
  runConfig.value = createRunConfig(0)
  transformOverrides.value = new Map()
  profileLoadedAt.value = 0
  lastEditAt.value = 0
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
 * Strip any version suffix (e.g., " v1.2", " v2.0") from a profile name.
 * Returns the base name without version suffix.
 */
function stripVersionSuffix(name: string): string {
  // Match patterns like " v1.2", " v2", " v1.0.3" at the end of the string
  return name.replace(/\s+v\d+(\.\d+)*$/i, '')
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
    // Strip any existing version suffix from the name before appending new version
    const baseName = stripVersionSuffix(activeProfile.value.name)
    suggestedName = `${baseName} v${suggestedVersion}`
  }

  const name = await showPrompt('Profile name:', suggestedName)
  if (!name) return

  const mappings: ProfileMapping[] = []
  const richMappingsArr: FieldMapping[] = []

  // Only include files that are currently uploaded (not orphan mappings)
  const uploadedFilenames = new Set(filesStore.files.map(f => f.name))

  for (const [filename, mapping] of config.fileMappings) {
    // Skip mappings for files that are no longer uploaded
    if (!uploadedFilenames.has(filename)) continue

    // Include all mapping properties (model, searchKeys, strict)
    const profileMapping: ProfileMapping = { filename, model: mapping.model }
    if (mapping.searchKeys && mapping.searchKeys.length > 0) {
      profileMapping.searchKeys = mapping.searchKeys
    }
    if (mapping.strict !== undefined) {
      profileMapping.strict = mapping.strict
    }
    mappings.push(profileMapping)

    // IMPORTANT: Always compute transform and required from field metadata
    // This ensures proper m2o_ref, m2m_ref, db_id transforms are saved
    const computedMappings = buildRichFieldMappings(filename, mapping.fieldMappings)
    richMappingsArr.push(...computedMappings)
  }

  // Only include files that are currently uploaded in the sequence
  const sequence: ProfileSequenceItem[] = config.importSequence
    .filter(filename => uploadedFilenames.has(filename))
    .map((filename, idx) => ({
      order: idx + 1,
      filename
    }))

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
    })

    activeProfile.value = newProfile
    runConfig.value = createRunConfig(newProfile.id)

    // Reset dirty state after save
    profileLoadedAt.value = Date.now()
    lastEditAt.value = 0

    showAlert(`Profile "${name}" saved to server.`)
  } catch (e) {
    showAlert(`Failed to save profile: ${(e as Error).message}`)
  }
}

/**
 * Increment the minor version (last digit) of a version string.
 * E.g., "1.5" → "1.6", "2.0" → "2.1", "1" → "1.1"
 * Major version (first digit) is only changed manually for bigger changes.
 */
function incrementMinorVersion(version: string): string {
  const parts = version.split('.')
  if (parts.length === 1) {
    // No minor version yet, add .1
    return `${parts[0]}.1`
  }
  // Increment the last part (minor version)
  const minor = parseInt(parts[parts.length - 1], 10) || 0
  parts[parts.length - 1] = String(minor + 1)
  return parts.join('.')
}

async function updateExistingProfile() {
  if (!activeProfile.value) return

  // Auto-increment minor version on every update
  const newVersion = incrementMinorVersion(activeProfile.value.version)

  const mappings: ProfileMapping[] = []
  const richMappingsArr: FieldMapping[] = []

  // Only include files that are currently uploaded (not orphan mappings)
  const uploadedFilenames = new Set(filesStore.files.map(f => f.name))

  for (const [filename, mapping] of config.fileMappings) {
    if (!uploadedFilenames.has(filename)) continue

    const profileMapping: ProfileMapping = { filename, model: mapping.model }
    if (mapping.searchKeys && mapping.searchKeys.length > 0) {
      profileMapping.searchKeys = mapping.searchKeys
    }
    if (mapping.strict !== undefined) {
      profileMapping.strict = mapping.strict
    }
    mappings.push(profileMapping)

    // Always compute transform and required from field metadata
    const computedMappings = buildRichFieldMappings(filename, mapping.fieldMappings)
    richMappingsArr.push(...computedMappings)
  }

  const sequence: ProfileSequenceItem[] = config.importSequence
    .filter(filename => uploadedFilenames.has(filename))
    .map((filename, idx) => ({
      order: idx + 1,
      filename
    }))

  try {
    const updatedProfile = await profiles.updateProfile(activeProfile.value.id, {
      version: newVersion,
      mappings,
      sequence,
      runSettings: { ...config.settings },
      fieldMappings: richMappingsArr.length > 0 ? richMappingsArr : undefined
    })

    activeProfile.value = updatedProfile
    runConfig.value = createRunConfig(updatedProfile.id)

    // Reset dirty state after save
    profileLoadedAt.value = Date.now()
    lastEditAt.value = 0

    showAlert(`Profile "${updatedProfile.name}" updated to v${newVersion}.`)
  } catch (e) {
    showAlert(`Failed to update profile: ${(e as Error).message}`)
  }
}
</script>

<template>
  <div class="csv-p-6 csv-space-y-6">
    <div class="csv-flex csv-justify-between csv-items-center">
      <h1 class="csv-text-2xl csv-font-semibold">{{ $t('nav.import') }}</h1>
      <div v-if="hasFiles" class="csv-flex csv-gap-2 csv-items-center">
        <span v-if="activeProfile" class="csv-text-xs" :class="hasUnsavedChanges ? 'csv-text-warning' : 'csv-text-muted'">
          {{ activeProfile.name }} v{{ activeProfile.version }}
          <span v-if="hasUnsavedChanges" class="csv-edited-badge">{{ $t('config.edited') }}</span>
        </span>
        <Button
          v-if="activeProfile"
          variant="outline"
          size="sm"
          @click="updateExistingProfile"
        >
          {{ $t('config.updateProfile') }}
        </Button>
        <Button variant="outline" size="sm" @click="saveAsProfile">
          {{ $t('config.saveAsProfile') }}
        </Button>
      </div>
    </div>

    <div v-if="loadError" class="csv-p-3 csv-bg-red-50 csv-text-red-700 csv-rounded csv-text-sm">
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
      <!-- Profile Loader -->
      <Card class="csv-p-4">
        <div class="csv-flex csv-justify-between csv-items-center csv-mb-3">
          <label class="csv-text-sm csv-font-medium">{{ $t('config.serverProfile') }}</label>
          <Button v-if="activeProfile" variant="ghost" size="sm" @click="clearProfile">
            {{ $t('common.clear') }}
          </Button>
        </div>
        <ProfileSelect
          :model-value="activeProfile?.id ?? null"
          :profiles="profiles.profileList"
          :loading="profiles.loading"
          @update:model-value="handleProfileSelect($event ?? 0)"
        />
        <div v-if="profileLoading" class="csv-text-sm csv-text-muted csv-mt-2">{{ $t('config.loadingProfileData') }}</div>
      </Card>

      <!-- Collapsible Import Settings -->
      <ImportSettings />

      <!-- Draggable File List -->
      <div class="csv-section-header">
        <span class="csv-section-title">{{ $t('config.fileListTitle') }}</span>
        <span class="csv-text-xs csv-text-muted">{{ fileListItems.length }} {{ $t('common.files', fileListItems.length) }}</span>
      </div>

      <FileList
        :files="fileListItems"
        @reorder="handleReorder"
        @remove="removeFile"
      >
        <template #expanded="{ file }">
          <div class="csv-file-config">
            <!-- 1. CSV Preview -->
            <div v-if="file.headers?.length" class="csv-config-section">
              <div class="csv-config-section__header">
                <span>{{ $t('config.csvPreview') }}</span>
                <span class="csv-text-xs csv-text-muted">
                  {{ file.headers.length }} {{ $t('common.columns', file.headers.length) }} · {{ file.rowCount?.toLocaleString() || '?' }} {{ $t('common.rows', 2) }}
                </span>
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
            <div v-if="config.getFileMapping(file.name)?.model && file.headers?.length" class="csv-config-section">
              <div class="csv-config-section__header">
                <span>{{ $t('config.fieldMappings') }}</span>
                <div class="csv-flex csv-items-center csv-gap-4">
                  <span class="csv-text-xs csv-text-muted">
                    {{ Object.keys(config.getFileMapping(file.name)?.fieldMappings || {}).length }} {{ $t('common.of') }} {{ file.headers.length }} {{ $t('config.mapped') }}
                  </span>
                  <label class="csv-strict-toggle" :title="$t('config.strictTooltip')">
                    <input
                      type="checkbox"
                      :checked="config.getFileMapping(file.name)?.strict ?? true"
                      @change="toggleStrictForFile(file.name, ($event.target as HTMLInputElement).checked)"
                    />
                    <span class="csv-text-xs">{{ $t('config.strict') }}</span>
                  </label>
                </div>
              </div>

              <div class="csv-mapping-table">
                <div class="csv-mapping-row csv-mapping-row--header">
                  <div class="csv-mapping-col csv-mapping-col--csv">{{ $t('config.csvColumn') }}</div>
                  <div class="csv-mapping-col csv-mapping-col--arrow"></div>
                  <div class="csv-mapping-col csv-mapping-col--field">{{ $t('config.odooField') }}</div>
                  <div class="csv-mapping-col csv-mapping-col--transform">{{ $t('config.transform') }}</div>
                  <div class="csv-mapping-col csv-mapping-col--req">{{ $t('config.req') }}</div>
                </div>

                <div
                  v-for="header in file.headers"
                  :key="header"
                  class="csv-mapping-row"
                  :class="{ 'csv-mapping-row--mapped': config.getFileMapping(file.name)?.fieldMappings[header] }"
                >
                  <div class="csv-mapping-col csv-mapping-col--csv" :title="header">{{ header }}</div>
                  <div class="csv-mapping-col csv-mapping-col--arrow">→</div>
                  <div class="csv-mapping-col csv-mapping-col--field">
                    <FieldSelect
                      :model-value="config.getFileMapping(file.name)?.fieldMappings[header] || ''"
                      :fields="getFieldsForFile(file.name)"
                      @update:model-value="updateFieldMappingForFile(file.name, header, $event)"
                    />
                  </div>
                  <div class="csv-mapping-col csv-mapping-col--transform">
                    <TransformSelect
                      v-if="getMappingInfoForFile(file.name, header)"
                      :model-value="getMappingInfoForFile(file.name, header)!.transform"
                      :field-type="getFieldInfoForMapping(file.name, header).fieldType"
                      :relation-model="getFieldInfoForMapping(file.name, header).relationModel"
                      @update:model-value="updateTransformForFile(file.name, header, $event)"
                    />
                    <span v-else class="csv-text-muted">-</span>
                  </div>
                  <div class="csv-mapping-col csv-mapping-col--req">
                    <span v-if="getMappingInfoForFile(file.name, header)" class="csv-req-indicator" :class="{ 'csv-req-indicator--active': getMappingInfoForFile(file.name, header)?.required }">
                      {{ getMappingInfoForFile(file.name, header)?.required ? '✓' : '-' }}
                    </span>
                    <span v-else>-</span>
                  </div>
                </div>
              </div>
            </div>

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

      <div class="csv-flex csv-justify-end">
        <Button
          :disabled="!canStartImport"
          @click="proceed"
        >
          {{ $t('config.startImport') }}
        </Button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Edited indicator */
.csv-text-warning {
  color: #d97706;
}
.csv-edited-badge {
  display: inline-block;
  margin-left: 0.25rem;
  padding: 0.125rem 0.375rem;
  font-size: 0.65rem;
  font-weight: 500;
  background: #fef3c7;
  color: #b45309;
  border-radius: 0.25rem;
}

.csv-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}
.csv-section-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: #374151;
}

/* File config inside expanded area */
.csv-file-config {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

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
  color: #374151;
}

/* CSV Preview */
.csv-preview__scroll {
  overflow-x: auto;
  max-width: 100%;
  border: 1px solid #e5e7eb;
  border-radius: var(--radius, 0.375rem);
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
  color: #374151;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  white-space: nowrap;
}
.csv-preview__table td {
  padding: 0.2rem 0.5rem;
  color: #6b7280;
  border-bottom: 1px solid #f3f4f6;
  white-space: nowrap;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Mapping table */
.csv-mapping-table {
  border: 1px solid #e5e7eb;
  border-radius: var(--radius, 0.375rem);
  overflow: hidden;
}
.csv-mapping-row {
  display: grid;
  grid-template-columns: minmax(120px, 180px) 24px 1fr minmax(100px, 150px) 70px;
  gap: 0.5rem;
  align-items: center;
  padding: 0.375rem 0.75rem;
  border-bottom: 1px solid #f3f4f6;
}
.csv-mapping-row:last-child {
  border-bottom: none;
}
.csv-mapping-row--header {
  font-size: 0.7rem;
  font-weight: 500;
  color: #6b7280;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
}
.csv-mapping-row--mapped {
  background: #f0fdf4;
}
.csv-mapping-col--csv {
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #374151;
}
.csv-mapping-col--arrow {
  text-align: center;
  color: #9ca3af;
  font-size: 0.75rem;
}
.csv-mapping-col--transform {
  font-size: 0.7rem;
}
.csv-mapping-col--req {
  text-align: center;
  font-size: 0.75rem;
}


/* Required indicator */
.csv-req-indicator {
  color: #9ca3af;
}
.csv-req-indicator--active {
  color: #16a34a;
  font-weight: 600;
}

/* Strict mode toggle */
.csv-strict-toggle {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
  background: #f3f4f6;
}
.csv-strict-toggle:hover {
  background: #e5e7eb;
}
.csv-strict-toggle input {
  margin: 0;
}

/* Validation result */
.csv-validation-result {
  margin-top: 0.5rem;
  padding: 0.5rem;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.75rem;
}
.csv-validation-result--ok {
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
}
.csv-validation-result--error {
  background: #fef2f2;
  border: 1px solid #fecaca;
}
.csv-validation-result__header {
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.csv-validation-result--ok .csv-validation-result__header {
  color: #166534;
}
.csv-validation-result--error .csv-validation-result__header {
  color: #991b1b;
}
.csv-validation-result__message {
  color: #374151;
  margin-bottom: 0.375rem;
}
.csv-validation-result__data {
  background: white;
  border-radius: 0.2rem;
  padding: 0.375rem;
  overflow-x: auto;
}
.csv-validation-result__data pre {
  margin: 0;
  font-size: 0.65rem;
  font-family: ui-monospace, monospace;
  color: #6b7280;
}
</style>
