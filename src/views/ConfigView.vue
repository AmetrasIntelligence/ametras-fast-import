<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '@/stores/files'
import { useConfigStore, type RunSettings } from '@/stores/config'
import { useProfilesStore } from '@/stores/profiles'
import { exportProfileToZip, downloadBlob } from '@/utils/profileZip'
import {
  exportProfileCSV,
  exportMappingsToCSV,
  exportSequenceToCSV,
  exportFieldMappingsToCSV,
  type ImportProfile,
  type ProfileMapping,
  type ProfileSequenceItem,
  type ProfileFieldMapping
} from '@/types/importProfile'
import { createRunConfig, type RunConfig } from '@/types/runConfig'
import { useSavedMappingsStore } from '@/stores/savedMappings'
import { fetchModels, fetchModelFields, type OdooModel, type OdooField } from '@/api/odooClient'
import { suggestModel } from '@/utils/smartMapping'
import { autoMapFields } from '@/utils/smartFieldMapping'
import { Button, Card, Checkbox } from '@/ui'
import ModelSelect from '@/components/ModelSelect.vue'
import ModelSuggestion from '@/components/ModelSuggestion.vue'
import ImportSettings from '@/components/ImportSettings.vue'
import MappingStatus from '@/components/MappingStatus.vue'
import FieldSelect from '@/components/FieldSelect.vue'
import ProfileEditor from '@/components/ProfileEditor.vue'

const router = useRouter()
const filesStore = useFilesStore()
const config = useConfigStore()
const savedMappings = useSavedMappingsStore()
const profiles = useProfilesStore()

// Profile state
const activeProfile = ref<ImportProfile | null>(null)
const runConfig = ref<RunConfig>(createRunConfig(0))
const profileLoading = ref(false)

const profileEffectiveRunSettings = computed<RunSettings | null>(() => {
  if (!activeProfile.value) return null
  return { ...activeProfile.value.runSettings, ...runConfig.value.runSettingsOverride } as RunSettings
})

const profileEffectiveMappings = computed(() => {
  if (!activeProfile.value) return []
  return activeProfile.value.mappings.map(m => {
    const override = runConfig.value.mappingsOverride.get(m.filename)
    return override ? { ...m, ...override } : m
  })
})

const profileEffectiveSequence = computed(() => {
  if (!activeProfile.value) return []
  return runConfig.value.sequenceOverride ?? activeProfile.value.sequence
})

const profileHasOverrides = computed(() => {
  return Object.keys(runConfig.value.runSettingsOverride).length > 0 ||
    runConfig.value.mappingsOverride.size > 0 ||
    runConfig.value.sequenceOverride !== null ||
    runConfig.value.fieldMappingsOverride.size > 0
})

const models = ref<OdooModel[]>([])
const fieldsCache = ref<Map<string, OdooField[]>>(new Map())
const selectedFile = ref<string | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const modelSuggestions = ref<Map<string, { model: OdooModel; score: number } | null>>(new Map())
const fieldSuggestionsApplied = ref<Set<string>>(new Set())

const files = computed(() => filesStore.files)

const currentAnalysis = computed(() => {
  const file = files.value.find(f => f.name === selectedFile.value)
  return file ? filesStore.getAnalysis(file.id) : null
})

const currentMapping = computed(() => {
  if (!selectedFile.value) return null
  return config.getFileMapping(selectedFile.value)
})

const currentModelFields = computed(() => {
  if (!currentMapping.value?.model) return []
  return fieldsCache.value.get(currentMapping.value.model) || []
})

const currentSuggestion = computed(() => {
  if (!selectedFile.value) return null
  return modelSuggestions.value.get(selectedFile.value) || null
})

// Compute overall mapping status per file for the tab display
function getFileStatus(filename: string): 'valid' | 'partial' | 'none' {
  const mapping = config.getFileMapping(filename)
  if (!mapping?.model) return 'none'

  const file = files.value.find(f => f.name === filename)
  const analysis = file ? filesStore.getAnalysis(file.id) : null
  if (!analysis?.headers) return 'valid'

  const mappedCount = Object.keys(mapping.fieldMappings || {}).length
  if (mappedCount === 0) return 'none'
  if (mappedCount < analysis.headers.length) return 'partial'
  return 'valid'
}

const canStartImport = computed(() =>
  files.value.length > 0 &&
  files.value.every(f => {
    const status = getFileStatus(f.name)
    return status !== 'none'
  })
)

const hasPartialMappings = computed(() =>
  files.value.some(f => getFileStatus(f.name) === 'partial')
)

onMounted(async () => {
  loading.value = true
  loadError.value = null
  try {
    models.value = await fetchModels()

    // Load saved mappings and server profiles
    await savedMappings.load()
    profiles.loadProfiles()

    if (files.value.length > 0) {
      selectedFile.value = files.value[0].name

      // Generate model suggestions for all files
      for (const file of files.value) {
        initMapping(file.name)

        // Check saved mappings first
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
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Failed to load models'
  } finally {
    loading.value = false
  }
})

function initMapping(filename: string) {
  if (!config.getFileMapping(filename)) {
    const analysis = filesStore.getAnalysis(files.value.find(f => f.name === filename)?.id || '')
    config.setFileMapping(filename, {
      filename,
      model: '',
      idColumn: analysis?.hasIdColumn ? 'id' : analysis?.hasDotIdColumn ? '.id' : null,
      fieldMappings: {}
    })
  }
}

async function selectModel(model: string) {
  if (!selectedFile.value) return

  // Reset field suggestions flag so auto-mapping runs for the new model
  fieldSuggestionsApplied.value.delete(selectedFile.value)

  const mapping = config.getFileMapping(selectedFile.value)
  if (mapping) {
    config.setFileMapping(selectedFile.value, { ...mapping, model, fieldMappings: {} })
  }

  if (!fieldsCache.value.has(model)) {
    const fields = await fetchModelFields(model)
    fieldsCache.value.set(model, fields)
  }

  // Auto-suggest field mappings
  const analysis = currentAnalysis.value
  const fields = fieldsCache.value.get(model)
  if (analysis && fields && !fieldSuggestionsApplied.value.has(selectedFile.value)) {
    const suggestions = autoMapFields(analysis.headers, fields)
    if (Object.keys(suggestions).length > 0 && mapping) {
      config.setFileMapping(selectedFile.value, { ...mapping, model, fieldMappings: suggestions })
      fieldSuggestionsApplied.value.add(selectedFile.value)
    }
  }

  // Save mapping for future use
  savedMappings.addMapping(selectedFile.value, model)
}

function acceptSuggestion(model: string) {
  selectModel(model)
}

function updateFieldMapping(csvCol: string, odooField: string) {
  if (!selectedFile.value) return
  const mapping = config.getFileMapping(selectedFile.value)
  if (mapping) {
    const fieldMappings = { ...mapping.fieldMappings }
    if (odooField) {
      fieldMappings[csvCol] = odooField
    } else {
      delete fieldMappings[csvCol]
    }
    config.setFileMapping(selectedFile.value, { ...mapping, fieldMappings })
  }
}

function updateIdColumn(idColumn: 'id' | '.id' | null) {
  if (!selectedFile.value) return
  const mapping = config.getFileMapping(selectedFile.value)
  if (mapping) {
    config.setFileMapping(selectedFile.value, { ...mapping, idColumn })
  }
}

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

    // Apply profile run settings to config store
    config.setSettings({ ...profile.runSettings })

    // Apply profile file mappings to matching files
    for (const mapping of profile.mappings) {
      const file = files.value.find(f => f.name === mapping.filename)
      if (file) {
        const existing = config.getFileMapping(mapping.filename)
        config.setFileMapping(mapping.filename, {
          filename: mapping.filename,
          model: mapping.model,
          idColumn: existing?.idColumn || null,
          fieldMappings: existing?.fieldMappings || {}
        })

        // Load model fields if not cached
        if (mapping.model && !fieldsCache.value.has(mapping.model)) {
          const fields = await fetchModelFields(mapping.model)
          fieldsCache.value.set(mapping.model, fields)
        }
      }
    }

    // Apply profile field mappings if available
    if (profile.fieldMappings) {
      for (const fm of profile.fieldMappings) {
        const existing = config.getFileMapping(fm.filename)
        if (existing) {
          const fieldMappings = { ...existing.fieldMappings, [fm.csvColumn]: fm.odooField }
          config.setFileMapping(fm.filename, { ...existing, fieldMappings })
        }
      }
    }

    // Apply profile sequence
    if (profile.sequence.length > 0) {
      config.setSequence(profile.sequence.map(s => s.filename))
    }
  } catch (e) {
    alert(`Failed to load profile: ${(e as Error).message}`)
    activeProfile.value = null
  } finally {
    profileLoading.value = false
  }
}

function clearProfile() {
  activeProfile.value = null
  runConfig.value = createRunConfig(0)
}

function handleRunSettingsOverride(overrides: Partial<RunSettings>) {
  runConfig.value = {
    ...runConfig.value,
    runSettingsOverride: { ...runConfig.value.runSettingsOverride, ...overrides }
  }
  config.setSettings(overrides)
}

function handleProfileResetAll() {
  if (!activeProfile.value) return
  runConfig.value = createRunConfig(activeProfile.value.id)
  config.setSettings({ ...activeProfile.value.runSettings })
}

function proceed() {
  if (hasPartialMappings.value) {
    const partialFiles = files.value
      .filter(f => getFileStatus(f.name) === 'partial')
      .map(f => f.name)
    if (!confirm(`${partialFiles.length} file(s) have unmapped fields: ${partialFiles.join(', ')}. Continue anyway?`)) {
      return
    }
  }
  router.push('/run')
}

async function saveAsProfile() {
  const name = prompt('Profile name:')
  if (!name) return

  // Build profile data and export as ZIP for upload
  const mappings: ProfileMapping[] = []
  const fieldMappingsArr: ProfileFieldMapping[] = []

  for (const [filename, mapping] of config.fileMappings) {
    mappings.push({ filename, model: mapping.model })
    for (const [csvCol, odooField] of Object.entries(mapping.fieldMappings)) {
      fieldMappingsArr.push({ filename, csvColumn: csvCol, odooField })
    }
  }

  const sequence: ProfileSequenceItem[] = config.importSequence.map((filename, idx) => ({
    order: idx + 1,
    filename
  }))

  const profile: ImportProfile = {
    id: 0,
    name,
    version: '1.0',
    mappings,
    sequence,
    runSettings: { ...config.settings },
    fieldMappings: fieldMappingsArr.length > 0 ? fieldMappingsArr : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  const csvFiles: Record<string, string> = {
    'profile.csv': exportProfileCSV(profile),
    'mappings.csv': exportMappingsToCSV(profile.mappings),
    'sequence.csv': exportSequenceToCSV(profile.sequence)
  }

  const settingsLines = ['key,value']
  for (const [key, value] of Object.entries(profile.runSettings)) {
    settingsLines.push(`${key},${value}`)
  }
  csvFiles['run_settings.csv'] = settingsLines.join('\n')

  if (fieldMappingsArr.length > 0) {
    csvFiles['field_mappings.csv'] = exportFieldMappingsToCSV(fieldMappingsArr)
  }

  try {
    const blob = await exportProfileToZip(csvFiles, name)
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_')
    downloadBlob(blob, `${safeName}.zip`)
    alert(`Profile "${name}" exported as ZIP. Upload it via the Saved Mappings page to save to server.`)
  } catch (e) {
    alert(`Failed to export profile: ${(e as Error).message}`)
  }
}
</script>

<template>
  <div class="csv-p-6 csv-space-y-6">
    <div class="csv-flex csv-justify-between csv-items-center">
      <h1 class="csv-text-2xl csv-font-semibold">Configure Import</h1>
      <Button variant="outline" size="sm" @click="saveAsProfile">
        Save as Profile
      </Button>
    </div>

    <div v-if="loadError" class="csv-p-3 csv-bg-red-50 csv-text-red-700 csv-rounded csv-text-sm">
      {{ loadError }}
    </div>

    <!-- Profile Loader -->
    <Card class="csv-p-4">
      <div class="csv-flex csv-justify-between csv-items-center csv-mb-2">
        <label class="csv-text-sm csv-font-medium">Server Profile</label>
        <Button v-if="activeProfile" variant="ghost" size="sm" @click="clearProfile">
          Clear
        </Button>
      </div>
      <div v-if="profiles.loading" class="csv-text-sm csv-text-muted">Loading profiles...</div>
      <div v-else-if="profiles.profileList.length === 0" class="csv-text-sm csv-text-muted">
        No profiles available. Upload one on the Profiles page.
      </div>
      <select
        v-else
        :value="activeProfile?.id || ''"
        class="csv-field-select csv-w-full"
        @change="handleProfileSelect(Number(($event.target as HTMLSelectElement).value))"
      >
        <option value="">(no profile)</option>
        <option v-for="p in profiles.profileList" :key="p.id" :value="p.id">
          {{ p.name }} (v{{ p.version }})
        </option>
      </select>
      <div v-if="profileLoading" class="csv-text-sm csv-text-muted csv-mt-1">Loading profile data...</div>
    </Card>

    <!-- Profile Editor (when profile is active) -->
    <ProfileEditor
      v-if="activeProfile && profileEffectiveRunSettings"
      :profile="activeProfile"
      :run-config="runConfig"
      :effective-run-settings="profileEffectiveRunSettings"
      :effective-mappings="profileEffectiveMappings"
      :effective-sequence="profileEffectiveSequence"
      :has-overrides="profileHasOverrides"
      @update:run-settings="handleRunSettingsOverride"
      @reset-all="handleProfileResetAll"
    />

    <!-- Collapsible Import Settings -->
    <ImportSettings />

    <!-- File Tabs -->
    <div class="csv-flex csv-gap-2 csv-flex-wrap csv-items-center">
      <div
        v-for="file in files"
        :key="file.name"
        class="csv-file-tab"
        :class="{ 'csv-file-tab--active': selectedFile === file.name }"
        @click="selectedFile = file.name; initMapping(file.name)"
      >
        <MappingStatus :status="getFileStatus(file.name)" compact />
        <span>{{ file.name }}</span>
      </div>
    </div>

    <Card v-if="selectedFile && currentAnalysis" class="csv-p-4 csv-space-y-4">
      <!-- Model Suggestion -->
      <ModelSuggestion
        :suggestion="currentSuggestion"
        :current-model="currentMapping?.model || null"
        @accept="acceptSuggestion"
        @choose-another="() => {}"
      />

      <!-- Model Selection -->
      <div>
        <label class="csv-text-sm csv-font-medium csv-mb-1 csv-block">Target Model</label>
        <ModelSelect
          :model-value="currentMapping?.model || null"
          @update:model-value="selectModel($event)"
        />
      </div>

      <!-- ID Column -->
      <div>
        <label class="csv-text-sm csv-font-medium csv-mb-2 csv-block">ID Column for Upsert</label>
        <div class="csv-flex csv-gap-4">
          <Checkbox
            :model-value="currentMapping?.idColumn === 'id'"
            label="External ID (id)"
            :disabled="!currentAnalysis.hasIdColumn"
            @update:model-value="updateIdColumn($event ? 'id' : null)"
          />
          <Checkbox
            :model-value="currentMapping?.idColumn === '.id'"
            label="Database ID (.id)"
            :disabled="!currentAnalysis.hasDotIdColumn"
            @update:model-value="updateIdColumn($event ? '.id' : null)"
          />
        </div>
      </div>

      <!-- Field Mappings -->
      <div v-if="currentMapping?.model">
        <div class="csv-flex csv-items-center csv-justify-between csv-mb-2">
          <label class="csv-text-sm csv-font-medium">Field Mappings</label>
          <MappingStatus :status="getFileStatus(selectedFile!)" />
        </div>
        <div class="csv-space-y-2">
          <div
            v-for="header in currentAnalysis.headers"
            :key="header"
            class="csv-flex csv-items-center csv-gap-4"
          >
            <span class="csv-w-48 csv-text-sm csv-truncate csv-shrink-0">{{ header }}</span>
            <span class="csv-text-muted">&rarr;</span>
            <FieldSelect
              :model-value="currentMapping?.fieldMappings[header] || ''"
              :fields="currentModelFields"
              @update:model-value="updateFieldMapping(header, $event)"
            />
          </div>
        </div>
      </div>
    </Card>

    <div class="csv-flex csv-justify-between">
      <Button variant="outline" @click="router.push('/files')">
        Back
      </Button>
      <Button
        :disabled="!canStartImport"
        @click="proceed"
      >
        Start Import
      </Button>
    </div>
  </div>
</template>

<style scoped>
.csv-file-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  border: 1px solid #e5e7eb;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.875rem;
  cursor: pointer;
  transition: background-color 0.15s;
}
.csv-file-tab:hover {
  background: #f3f4f6;
}
.csv-file-tab--active {
  background: #2563eb;
  color: white;
  border-color: #2563eb;
}
.csv-field-select {
  flex: 1;
  height: 1.75rem;
  padding: 0 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.8rem;
  font-family: inherit;
  background: white;
}
</style>
