<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProfilesStore } from '@/stores/profiles'
import { DEFAULT_RUN_SETTINGS, type RunSettings } from '@/stores/config'
import { fetchModelFields, fetchModels, type OdooField, type OdooModel } from '@/api/odooClient'
import { showAlert } from '@/composables/useDialog'
import type { ImportProfile, ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import type { FieldMapping } from '@/types/fieldMapping'
import type { ProfileWizardSeed } from '@/types/profileWizard'
import { suggestModel } from '@/utils/smartMapping'
import { autoMapFields } from '@/utils/smartFieldMapping'
import { buildFieldLookup, computeFieldMetadata as computeFieldMetadataFromLookup } from '@/utils/fieldMappingMetadata'
import { createRunConfig } from '@/types/runConfig'
import { Button } from '@/ui'
import ModelSelect from '@/components/ModelSelect.vue'
import FieldSelect from '@/components/FieldSelect.vue'
import ProfileEditorSettings from '@/components/ProfileEditorSettings.vue'
import ModelSuggestion from '@/components/ModelSuggestion.vue'

interface MappingRow {
  filename: string
  model: string
  strict: boolean
  searchKeys?: string[]
}

type FieldMappingRow = FieldMapping

type SourceMode = 'scratch' | 'sample' | 'clone'

const props = withDefaults(defineProps<{
  mode: 'create' | 'edit'
  editProfile?: ImportProfile | null
  sampleSeed?: ProfileWizardSeed | null
  allowSample?: boolean
  initialSource?: SourceMode
  initialCloneProfileId?: number | null
}>(), {
  editProfile: null,
  sampleSeed: null,
  allowSample: false,
  initialSource: 'scratch',
  initialCloneProfileId: null
})

const emit = defineEmits<{
  cancel: []
  saved: [profile: ImportProfile]
}>()

const { t } = useI18n()
const profiles = useProfilesStore()

const saving = ref(false)
const loadingClone = ref(false)
const currentStep = ref(1)
const settingsRunConfig = ref(createRunConfig(0))
const models = ref<OdooModel[]>([])
const modelSuggestions = ref<Map<string, { model: OdooModel; score: number } | null>>(new Map())

const sourceMode = ref<SourceMode>(props.initialSource)
const cloneSourceId = ref<number | null>(props.initialCloneProfileId)
let cloneLoadToken = 0

const fieldsCache = ref<Map<string, OdooField[]>>(new Map())

const form = reactive({
  name: '',
  version: '1.0',
  description: '',
  odooMinVersion: '',
  mappings: [] as MappingRow[],
  fieldMappings: [] as FieldMappingRow[],
  runSettings: { ...DEFAULT_RUN_SETTINGS } as RunSettings
})

const isCreate = computed(() => props.mode === 'create')
const sourceStep = computed(() => (isCreate.value ? 1 : 0))
const metadataStep = computed(() => (isCreate.value ? 2 : 1))
const detailsStep = computed(() => (isCreate.value ? 3 : 2))
const totalSteps = computed(() => (isCreate.value ? 3 : 2))

const cloneCandidates = computed(() => {
  return profiles.profileList.filter(p => !props.editProfile || p.id !== props.editProfile.id)
})

const mappingFilenames = computed(() => {
  const names = form.mappings.map(m => m.filename.trim()).filter(Boolean)
  return Array.from(new Set(names))
})

const sampleHeadersByFilename = computed(() => {
  const map = new Map<string, string[]>()
  const samples = props.sampleSeed?.samples || []
  for (const sample of samples) {
    map.set(sample.filename, sample.headers)
  }
  return map
})

const completeMappings = computed(() => {
  return form.mappings
    .filter(m => m.filename.trim() && m.model.trim())
})

const sourceStepReady = computed(() => {
  if (sourceMode.value === 'scratch') return true
  if (sourceMode.value === 'sample') return Boolean(props.allowSample && props.sampleSeed)
  return cloneSourceId.value !== null
})

const metadataStepReady = computed(() => form.name.trim().length > 0)

function sortMappingsBySequence(
  mappings: ProfileMapping[],
  sequence: ProfileSequenceItem[]
): ProfileMapping[] {
  const orderMap = new Map(sequence.map(item => [item.filename, item.order]))
  return [...mappings].sort((a, b) => {
    const aOrder = orderMap.get(a.filename) ?? Number.MAX_SAFE_INTEGER
    const bOrder = orderMap.get(b.filename) ?? Number.MAX_SAFE_INTEGER
    if (aOrder !== bOrder) return aOrder - bOrder
    return a.filename.localeCompare(b.filename)
  })
}

function withCopySuffix(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return t('profileWizard.defaultName')
  const suffix = t('profileWizard.copySuffix')
  if (trimmed.toLowerCase().endsWith(` ${suffix}`.toLowerCase())) {
    return trimmed
  }
  return `${trimmed} ${suffix}`
}

function clearFormForScratch() {
  form.name = ''
  form.version = '1.0'
  form.description = ''
  form.odooMinVersion = ''
  form.runSettings = { ...DEFAULT_RUN_SETTINGS }
  form.mappings = [{ filename: '', model: '', strict: false }]
  form.fieldMappings = []
}

function applySeed(seed: ProfileWizardSeed, asClone: boolean) {
  form.name = asClone ? withCopySuffix(seed.name || '') : (seed.name || '')
  form.version = seed.version || '1.0'
  form.description = seed.description || ''
  form.odooMinVersion = seed.odooMinVersion || ''
  form.runSettings = { ...DEFAULT_RUN_SETTINGS, ...seed.runSettings }
  let orderedMappings = sortMappingsBySequence(seed.mappings || [], seed.sequence || [])
  if (orderedMappings.length === 0 && seed.samples && seed.samples.length > 0) {
    orderedMappings = seed.samples.map(sample => ({
      filename: sample.filename,
      model: '',
      strict: false
    }))
  }

  form.mappings = orderedMappings.map(m => ({
    filename: m.filename,
    model: m.model,
    strict: !!m.strict,
    searchKeys: m.searchKeys ? [...m.searchKeys] : undefined
  }))
  if (form.mappings.length === 0) {
    form.mappings = [{ filename: '', model: '', strict: false }]
  }
  form.fieldMappings = (seed.richFieldMappings || []).map(fm => ({
    filename: fm.filename,
    csvHeader: fm.csvHeader,
    odooField: fm.odooField,
    required: fm.required,
    transform: fm.transform,
    notes: fm.notes
  }))
  refreshModelSuggestions()
  void preloadFieldsFromMappings()
}

function profileToSeed(profile: ImportProfile): ProfileWizardSeed {
  return {
    name: profile.name,
    version: profile.version,
    description: profile.description,
    odooMinVersion: profile.odooMinVersion,
    mappings: profile.mappings || [],
    sequence: profile.sequence || [],
    runSettings: { ...DEFAULT_RUN_SETTINGS, ...profile.runSettings },
    richFieldMappings: profile.richFieldMappings || []
  }
}

async function preloadFieldsFromMappings() {
  const rows = form.mappings
    .map(row => ({
      filename: row.filename.trim(),
      model: row.model.trim()
    }))
    .filter(row => row.filename && row.model)

  const models = Array.from(new Set(rows.map(row => row.model)))
  await Promise.all(models.map(model => ensureModelFields(model)))

  for (const row of rows) {
    applyAutoFieldMappings(row.filename, row.model)
  }
}

async function ensureModelFields(model: string) {
  if (!model || fieldsCache.value.has(model)) return
  const fields = await fetchModelFields(model)
  fieldsCache.value.set(model, fields)
}

function refreshModelSuggestions() {
  const next = new Map<string, { model: OdooModel; score: number } | null>()
  for (const row of form.mappings) {
    const filename = row.filename.trim()
    if (!filename || row.model.trim()) continue
    const headers = sampleHeadersByFilename.value.get(filename)
    const suggestion = models.value.length > 0
      ? suggestModel(filename, models.value, 20, { headers })
      : null
    next.set(filename, suggestion)
  }
  modelSuggestions.value = next
}

function getModelSuggestion(filename: string): { model: OdooModel; score: number } | null {
  return modelSuggestions.value.get(filename.trim()) || null
}

function getModelForFilename(filename: string): string {
  const row = form.mappings.find(m => m.filename.trim() === filename)
  return row?.model || ''
}

function getFieldsForFilename(filename: string): OdooField[] {
  const model = getModelForFilename(filename)
  if (!model) return []
  return fieldsCache.value.get(model) || []
}

function computeFieldMetadataForRow(
  filename: string,
  csvHeader: string,
  odooField: string
) {
  const fieldLookup = buildFieldLookup(getFieldsForFilename(filename))
  return computeFieldMetadataFromLookup(csvHeader, odooField, fieldLookup)
}

function applyCreateSource(mode: SourceMode) {
  if (mode === 'scratch') {
    clearFormForScratch()
    return
  }

  if (mode === 'sample') {
    if (props.allowSample && props.sampleSeed) {
      applySeed(props.sampleSeed, false)
    } else {
      clearFormForScratch()
    }
  }
}

async function loadCloneSource(profileId: number) {
  const token = ++cloneLoadToken
  loadingClone.value = true
  try {
    const profile = await profiles.loadProfile(profileId)
    if (token !== cloneLoadToken) return
    applySeed(profileToSeed(profile), true)
  } catch (e) {
    showAlert(t('profileWizard.failedToLoadClone', { error: (e as Error).message }))
  } finally {
    if (token === cloneLoadToken) {
      loadingClone.value = false
    }
  }
}

watch(
  () => props.editProfile,
  (profile) => {
    if (!isCreate.value && profile) {
      applySeed(profileToSeed(profile), false)
      currentStep.value = 1
    }
  },
  { immediate: true }
)

watch(
  () => sourceMode.value,
  async (mode) => {
    if (!isCreate.value) return
    if (mode === 'clone') {
      if (cloneSourceId.value !== null) {
        await loadCloneSource(cloneSourceId.value)
      } else {
        clearFormForScratch()
      }
      return
    }
    applyCreateSource(mode)
  },
  { immediate: true }
)

watch(
  () => cloneSourceId.value,
  async (profileId) => {
    if (!isCreate.value || sourceMode.value !== 'clone' || profileId === null) return
    await loadCloneSource(profileId)
  },
  { immediate: true }
)

function nextStep() {
  if (currentStep.value >= totalSteps.value) return
  currentStep.value += 1
}

function previousStep() {
  if (currentStep.value <= 1) return
  currentStep.value -= 1
}

function addMappingRow() {
  form.mappings.push({ filename: '', model: '', strict: false })
}

function removeMappingRow(index: number) {
  form.mappings.splice(index, 1)
  if (form.mappings.length === 0) {
    addMappingRow()
  }
}

async function updateMappingModel(index: number, model: string) {
  form.mappings[index].model = model
  const filename = form.mappings[index].filename.trim()
  refreshModelSuggestions()
  if (!model || !filename) return
  try {
    await ensureModelFields(model)
    applyAutoFieldMappings(filename, model)
  } catch (e) {
    showAlert(t('profileWizard.failedToLoadFields', { error: (e as Error).message }))
  }
}

function addFieldMappingRow() {
  form.fieldMappings.push({
    filename: mappingFilenames.value[0] || '',
    csvHeader: '',
    odooField: '',
    required: false,
    transform: { type: 'passthrough' }
  })
}

function removeFieldMappingRow(index: number) {
  form.fieldMappings.splice(index, 1)
}

async function updateFieldMappingFilename(index: number, filename: string) {
  form.fieldMappings[index].filename = filename
  const model = getModelForFilename(filename)
  if (model) {
    try {
      await ensureModelFields(model)
    } catch {
      // Field selector will stay disabled when fetch fails.
    }
  }
}

function updateFieldMappingField(index: number, odooField: string) {
  const row = form.fieldMappings[index]
  row.odooField = odooField
  if (!odooField) {
    row.required = false
    row.transform = { type: 'passthrough' }
    return
  }
  const metadata = computeFieldMetadataForRow(row.filename, row.csvHeader, odooField)
  row.required = metadata.required
  row.transform = metadata.transform
}

function applyAutoFieldMappings(filename: string, model: string) {
  const headers = sampleHeadersByFilename.value.get(filename)
  if (!headers || headers.length === 0) return

  const fields = fieldsCache.value.get(model)
  if (!fields) return

  const suggestions = autoMapFields(headers, fields)
  for (const [csvHeader, odooField] of Object.entries(suggestions)) {
    const existingIdx = form.fieldMappings.findIndex(
      row => row.filename.trim() === filename && row.csvHeader.trim() === csvHeader
    )

    const metadata = computeFieldMetadataForRow(filename, csvHeader, odooField)
    if (existingIdx >= 0) {
      // Keep explicit manual choices; only fill empty targets.
      if (!form.fieldMappings[existingIdx].odooField.trim()) {
        form.fieldMappings[existingIdx].odooField = odooField
        form.fieldMappings[existingIdx].required = metadata.required
        form.fieldMappings[existingIdx].transform = metadata.transform
      }
      continue
    }

    form.fieldMappings.push({
      filename,
      csvHeader,
      odooField,
      required: metadata.required,
      transform: metadata.transform
    })
  }
}

function updateRunSetting(key: string, value: unknown) {
  if (!(key in form.runSettings)) return
  const next = { ...form.runSettings, [key]: value } as RunSettings
  form.runSettings = next
}

function normalizeFieldMappings(fieldMappings: FieldMappingRow[]): FieldMapping[] {
  const validFilenameSet = new Set(completeMappings.value.map(m => m.filename.trim()))
  return fieldMappings
    .filter(row => {
      return Boolean(
        row.filename.trim() &&
        row.csvHeader.trim() &&
        row.odooField.trim() &&
        validFilenameSet.has(row.filename.trim())
      )
    })
    .map(row => ({
      filename: row.filename.trim(),
      csvHeader: row.csvHeader.trim(),
      odooField: row.odooField.trim(),
      required: row.required,
      transform: row.transform,
      notes: row.notes?.trim() || undefined
    }))
}

function buildPayload() {
  const mappings = completeMappings.value.map<ProfileMapping>(row => {
    const mapping: ProfileMapping = {
      filename: row.filename.trim(),
      model: row.model.trim(),
      strict: row.strict
    }
    if (row.searchKeys && row.searchKeys.length > 0) {
      mapping.searchKeys = [...row.searchKeys]
    }
    return mapping
  })

  const sequence: ProfileSequenceItem[] = mappings.map((mapping, idx) => ({
    order: idx + 1,
    filename: mapping.filename
  }))

  const fieldMappings = normalizeFieldMappings(form.fieldMappings)

  return {
    name: form.name.trim(),
    version: form.version.trim() || '1.0',
    description: form.description.trim(),
    odooMinVersion: form.odooMinVersion.trim(),
    mappings,
    sequence,
    runSettings: {
      batchSize: form.runSettings.batchSize,
      encoding: form.runSettings.encoding,
      delimiter: form.runSettings.delimiter,
      skipHeader: form.runSettings.skipHeader,
      dryRun: form.runSettings.dryRun,
      lang: form.runSettings.lang
    },
    fieldMappings: fieldMappings.length > 0 ? fieldMappings : undefined
  }
}

async function handlePrimaryAction() {
  if (isCreate.value && currentStep.value === sourceStep.value && !sourceStepReady.value) {
    return
  }

  if (currentStep.value === metadataStep.value && !metadataStepReady.value) {
    return
  }

  if (currentStep.value < totalSteps.value) {
    nextStep()
    return
  }

  if (completeMappings.value.length === 0) {
    await showAlert(t('profileWizard.validationNeedMappings'))
    return
  }

  const duplicateNames = new Set<string>()
  const seen = new Set<string>()
  for (const mapping of completeMappings.value) {
    const filename = mapping.filename.trim()
    if (seen.has(filename)) {
      duplicateNames.add(filename)
    } else {
      seen.add(filename)
    }
  }
  if (duplicateNames.size > 0) {
    await showAlert(t('profileWizard.validationDuplicateFilenames', { files: Array.from(duplicateNames).join(', ') }))
    return
  }

  saving.value = true
  try {
    const payload = buildPayload()
    const profile = isCreate.value || !props.editProfile
      ? await profiles.createProfile(payload)
      : await profiles.updateProfile(props.editProfile.id, payload)
    emit('saved', profile)
  } catch (e) {
    await showAlert(t('profileWizard.saveFailed', { error: (e as Error).message }))
  } finally {
    saving.value = false
  }
}

function parseCloneSource(value: string) {
  if (!value) {
    cloneSourceId.value = null
    return
  }
  const parsed = Number.parseInt(value, 10)
  cloneSourceId.value = Number.isFinite(parsed) ? parsed : null
}

const primaryLabel = computed(() => {
  if (currentStep.value < totalSteps.value) return t('profileWizard.next')
  if (isCreate.value) return t('profileWizard.create')
  return t('profileWizard.saveChanges')
})

onMounted(async () => {
  try {
    models.value = await fetchModels()
    refreshModelSuggestions()
  } catch {
    // suggestions stay unavailable when model list cannot be loaded
  }
})

watch(
  () => form.mappings.map(row => `${row.filename.trim()}::${row.model.trim()}`),
  () => {
    refreshModelSuggestions()
  },
  { deep: true }
)
</script>

<template>
  <form class="csv-profile-wizard-form d-flex flex-column gap-3" @submit.prevent="handlePrimaryAction">
    <div class="d-flex align-items-center justify-content-between">
      <div>
        <h2 class="fs-5 fw-semibold mb-1">
          {{ isCreate ? $t('profileWizard.createTitle') : $t('profileWizard.editTitle') }}
        </h2>
        <p class="text-body-secondary small mb-0">
          {{ $t('profileWizard.stepCounter', { current: currentStep, total: totalSteps }) }}
        </p>
      </div>
    </div>

    <div v-if="isCreate && currentStep === sourceStep" class="d-flex flex-column gap-3">
      <div class="csv-profile-wizard-form__source-grid">
        <label class="csv-profile-wizard-form__source-card" :class="{ 'is-active': sourceMode === 'scratch' }">
          <input
            v-model="sourceMode"
            class="form-check-input mt-0"
            type="radio"
            name="source-mode"
            value="scratch"
          />
          <div>
            <div class="fw-medium">{{ $t('profileWizard.sourceScratch') }}</div>
            <div class="text-body-secondary small">{{ $t('profileWizard.sourceScratchHint') }}</div>
          </div>
        </label>

        <label
          class="csv-profile-wizard-form__source-card"
          :class="{ 'is-active': sourceMode === 'sample', 'is-disabled': !(allowSample && sampleSeed) }"
        >
          <input
            v-model="sourceMode"
            class="form-check-input mt-0"
            type="radio"
            name="source-mode"
            value="sample"
            :disabled="!(allowSample && sampleSeed)"
          />
          <div>
            <div class="fw-medium">{{ $t('profileWizard.sourceSample') }}</div>
            <div class="text-body-secondary small">{{ $t('profileWizard.sourceSampleHint') }}</div>
          </div>
        </label>

        <label class="csv-profile-wizard-form__source-card" :class="{ 'is-active': sourceMode === 'clone' }">
          <input
            v-model="sourceMode"
            class="form-check-input mt-0"
            type="radio"
            name="source-mode"
            value="clone"
          />
          <div>
            <div class="fw-medium">{{ $t('profileWizard.sourceClone') }}</div>
            <div class="text-body-secondary small">{{ $t('profileWizard.sourceCloneHint') }}</div>
          </div>
        </label>
      </div>

      <div v-if="sourceMode === 'clone'" class="csv-profile-wizard-form__clone-select">
        <label class="form-label small text-body-secondary mb-1">{{ $t('profileWizard.cloneFromProfile') }}</label>
        <select
          class="form-select form-select-sm"
          :value="cloneSourceId ?? ''"
          @change="parseCloneSource(($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ $t('profileWizard.chooseProfile') }}</option>
          <option
            v-for="profile in cloneCandidates"
            :key="profile.id"
            :value="profile.id"
          >
            {{ profile.name }} (v{{ profile.version }})
          </option>
        </select>
        <small v-if="loadingClone" class="text-body-secondary mt-1 d-block">
          {{ $t('profileWizard.loadingClone') }}
        </small>
      </div>
    </div>

    <div v-if="currentStep === metadataStep" class="d-flex flex-column gap-3">
      <div class="row g-3">
        <div class="col-md-6">
          <label class="form-label small text-body-secondary mb-1">{{ $t('profileWizard.name') }}</label>
          <input
            v-model="form.name"
            type="text"
            class="form-control form-control-sm"
            required
          />
        </div>
        <div class="col-md-3">
          <label class="form-label small text-body-secondary mb-1">{{ $t('profileWizard.version') }}</label>
          <input
            v-model="form.version"
            type="text"
            class="form-control form-control-sm"
            placeholder="1.0"
          />
        </div>
        <div class="col-md-3">
          <label class="form-label small text-body-secondary mb-1">{{ $t('profileWizard.odooMinVersion') }}</label>
          <input
            v-model="form.odooMinVersion"
            type="text"
            class="form-control form-control-sm"
            placeholder="16.0"
          />
        </div>
      </div>
      <div>
        <label class="form-label small text-body-secondary mb-1">{{ $t('profileWizard.description') }}</label>
        <textarea
          v-model="form.description"
          class="form-control form-control-sm"
          rows="3"
        />
      </div>
    </div>

    <div v-if="currentStep === detailsStep" class="d-flex flex-column gap-4">
      <div>
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h3 class="fs-6 fw-semibold mb-0">{{ $t('profileWizard.mappings') }}</h3>
          <Button variant="outline" size="sm" @click="addMappingRow">
            {{ $t('profileWizard.addMapping') }}
          </Button>
        </div>
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0">
            <thead>
              <tr>
                <th>{{ $t('profileWizard.filename') }}</th>
                <th>{{ $t('profileWizard.model') }}</th>
                <th class="text-center" style="width: 6rem;">{{ $t('config.strict') }}</th>
                <th class="text-end" style="width: 4rem;"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in form.mappings" :key="`mapping-${idx}`">
                <td>
                  <input
                    v-model="row.filename"
                    type="text"
                    class="form-control form-control-sm"
                    :placeholder="$t('profileWizard.filenamePlaceholder')"
                  />
                </td>
                <td>
                  <ModelSelect
                    :model-value="row.model || null"
                    @update:model-value="updateMappingModel(idx, $event)"
                  />
                  <div class="mt-2">
                    <ModelSuggestion
                      :suggestion="getModelSuggestion(row.filename)"
                      :current-model="row.model || null"
                      @accept="updateMappingModel(idx, $event)"
                    />
                  </div>
                </td>
                <td class="text-center">
                  <input
                    v-model="row.strict"
                    class="form-check-input"
                    type="checkbox"
                  />
                </td>
                <td class="text-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    :disabled="form.mappings.length === 1"
                    @click="removeMappingRow(idx)"
                  >
                    {{ $t('common.remove') }}
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h3 class="fs-6 fw-semibold mb-0">{{ $t('profileWizard.fieldMappings') }}</h3>
          <Button
            variant="outline"
            size="sm"
            :disabled="mappingFilenames.length === 0"
            @click="addFieldMappingRow"
          >
            {{ $t('profileWizard.addFieldMapping') }}
          </Button>
        </div>
        <div v-if="mappingFilenames.length === 0" class="small text-body-secondary">
          {{ $t('profileWizard.needMappingsFirst') }}
        </div>
        <div v-else class="table-responsive">
          <table class="table table-sm align-middle mb-0">
            <thead>
              <tr>
                <th>{{ $t('profileWizard.file') }}</th>
                <th>{{ $t('profileWizard.csvHeader') }}</th>
                <th>{{ $t('profileWizard.odooField') }}</th>
                <th class="text-center" style="width: 5rem;">{{ $t('config.req') }}</th>
                <th class="text-end" style="width: 4rem;"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in form.fieldMappings" :key="`field-mapping-${idx}`">
                <td>
                  <select
                    class="form-select form-select-sm"
                    :value="row.filename"
                    @change="updateFieldMappingFilename(idx, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">{{ $t('profileWizard.chooseFile') }}</option>
                    <option
                      v-for="filename in mappingFilenames"
                      :key="filename"
                      :value="filename"
                    >
                      {{ filename }}
                    </option>
                  </select>
                </td>
                <td>
                  <input
                    v-model="row.csvHeader"
                    type="text"
                    class="form-control form-control-sm"
                  />
                </td>
                <td>
                  <FieldSelect
                    :model-value="row.odooField"
                    :fields="getFieldsForFilename(row.filename)"
                    :disabled="!row.filename || !getModelForFilename(row.filename)"
                    @update:model-value="updateFieldMappingField(idx, $event)"
                  />
                </td>
                <td class="text-center">
                  <span v-if="row.required" class="text-warning">{{ $t('common.yes') }}</span>
                  <span v-else class="text-body-secondary">-</span>
                </td>
                <td class="text-end">
                  <Button variant="ghost" size="sm" @click="removeFieldMappingRow(idx)">
                    {{ $t('common.remove') }}
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 class="fs-6 fw-semibold mb-2">{{ $t('profileWizard.runSettings') }}</h3>
        <ProfileEditorSettings
          :effective-run-settings="form.runSettings"
          :run-config="settingsRunConfig"
          @update:setting="updateRunSetting"
        />
      </div>
    </div>

    <div class="d-flex justify-content-between align-items-center pt-2 border-top">
      <Button
        variant="ghost"
        size="sm"
        @click="emit('cancel')"
      >
        {{ $t('common.cancel') }}
      </Button>

      <div class="d-flex gap-2">
        <Button
          v-if="currentStep > 1"
          variant="outline"
          size="sm"
          @click="previousStep"
        >
          {{ $t('profileWizard.back') }}
        </Button>
        <Button
          type="submit"
          size="sm"
          :disabled="saving || (isCreate && currentStep === sourceStep && !sourceStepReady) || (currentStep === metadataStep && !metadataStepReady)"
          :loading="saving"
        >
          {{ primaryLabel }}
        </Button>
      </div>
    </div>
  </form>
</template>

<style scoped>
.csv-profile-wizard-form__source-grid {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.csv-profile-wizard-form__source-card {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.75rem;
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  cursor: pointer;
  background: var(--bs-body-bg);
}

.csv-profile-wizard-form__source-card.is-active {
  border-color: var(--bs-primary);
  background: color-mix(in srgb, var(--bs-primary) 8%, transparent);
}

.csv-profile-wizard-form__source-card.is-disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
