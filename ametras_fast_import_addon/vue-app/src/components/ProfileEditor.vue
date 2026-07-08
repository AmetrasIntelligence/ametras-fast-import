<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ImportProfile, ProfileCreateData } from '@/types/importProfile'
import type { RunConfig } from '@/types/runConfig'
import type { RunSettings } from '@/stores/config'
import type { FieldMapping, FieldTransform } from '@/types/fieldMapping'
import { serializeTransform } from '@/types/fieldMapping'
import { fetchModelFields, fetchModels, type OdooField, type OdooModel } from '@/api/odooClient'
import { baseFieldName, deriveFieldMetadata } from '@/utils/fieldMetadata'
import { suggestModel } from '@/utils/smartModelMapping'
import { seedDraftFiles, buildFilesSaveData, type DraftFile } from '@/utils/profileFiles'
import ProfileEditorSettings from './ProfileEditorSettings.vue'
import FieldSelect from './FieldSelect.vue'
import TransformSelect from './TransformSelect.vue'
import ModelSelect from './ModelSelect.vue'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    profile: ImportProfile
    runConfig: RunConfig
    effectiveRunSettings: RunSettings
    effectiveMappings: ImportProfile['mappings']
    effectiveSequence: ImportProfile['sequence']
    hasOverrides: boolean
    /** When true, the tabs become an in-place editor (standalone only). */
    editable?: boolean
    saving?: boolean
  }>(),
  { editable: false, saving: false }
)

const emit = defineEmits<{
  'update:runSettings': [overrides: Partial<RunSettings>]
  'reset-all': []
  save: [data: Partial<ProfileCreateData>]
}>()

// Order requested by the business: Einstellungen / Reihenfolge /
// Modelzuordnungen / Feldzuordnungen.
type Tab = 'settings' | 'sequence' | 'mappings' | 'field-mappings'
const activeTab = ref<Tab>('settings')

const tabs = computed(() => [
  { key: 'settings' as Tab, label: t('profileEditor.tabs.settings') },
  { key: 'sequence' as Tab, label: t('profileEditor.tabs.sequence') },
  { key: 'mappings' as Tab, label: t('profileEditor.tabs.mappings') },
  { key: 'field-mappings' as Tab, label: t('profileEditor.tabs.fieldMappings') }
])

const hasSettingsOverrides = computed(() =>
  Object.keys(props.runConfig.runSettingsOverride).length > 0
)
const hasMappingsOverrides = computed(() => props.runConfig.mappingsOverride.size > 0)
const hasSequenceOverride = computed(() => props.runConfig.sequenceOverride !== null)
const hasFieldMappingsOverrides = computed(() =>
  props.runConfig.fieldMappingsOverride.size > 0
)

function isOverridden(tab: Tab): boolean {
  switch (tab) {
    case 'settings': return hasSettingsOverrides.value
    case 'mappings': return hasMappingsOverrides.value
    case 'sequence': return hasSequenceOverride.value
    case 'field-mappings': return hasFieldMappingsOverrides.value
  }
}

// ── Read-only display ───────────────────────────────────────────────
const fieldMappings = computed(() => props.profile.richFieldMappings || [])

// ── Editable draft state (only used when props.editable) ────────────
// A single ordered file list is the source of truth for both the
// Reihenfolge (order) and Modelzuordnungen (filename → model) tabs — exactly
// like the addon's csv.import.profile.file child records. Each row carries a
// stable _uid so filenames / CSV headers stay editable without the bound
// <input> losing focus on every keystroke.
type DraftFileRow = DraftFile & { _uid: number }
type DraftFieldRow = FieldMapping & { _uid: number }
let uidCounter = 0

const draftFiles = ref<DraftFileRow[]>([])
const draftFields = ref<DraftFieldRow[]>([])
const draftSettings = reactive<Partial<RunSettings>>({})
const fieldsByModel = ref<Map<string, OdooField[]>>(new Map())
const allModels = ref<OdooModel[]>([])
const loadingFields = ref(false)
const dirty = ref(false)
const newFilename = ref('')
const newFieldFile = ref('')

function seedDraft() {
  draftFiles.value = seedDraftFiles(props.profile.mappings, props.profile.sequence).map(
    (f) => ({ ...f, _uid: uidCounter++ })
  )

  draftFields.value = (props.profile.richFieldMappings || []).map((fm) => ({
    filename: fm.filename,
    csvHeader: fm.csvHeader,
    odooField: fm.odooField,
    required: fm.required,
    transform: { ...fm.transform } as FieldTransform,
    ...(fm.notes ? { notes: fm.notes } : {}),
    _uid: uidCounter++
  }))

  for (const key of Object.keys(draftSettings)) {
    delete (draftSettings as Record<string, unknown>)[key]
  }
  Object.assign(draftSettings, props.profile.runSettings)
  newFilename.value = ''
  newFieldFile.value = ''
  dirty.value = false
}

function modelForFile(filename: string): string {
  return draftFiles.value.find((f) => f.filename === filename)?.model || ''
}

async function ensureModelFields(model: string) {
  if (model && !fieldsByModel.value.has(model)) {
    fieldsByModel.value.set(model, await fetchModelFields(model))
  }
}

async function loadDraftFields() {
  loadingFields.value = true
  try {
    for (const model of new Set(draftFiles.value.map((f) => f.model).filter(Boolean))) {
      await ensureModelFields(model)
    }
  } finally {
    loadingFields.value = false
  }
}

/** Lazily load the model list, used to suggest a target model for new files. */
async function ensureModels() {
  if (allModels.value.length > 0) return
  try {
    allModels.value = await fetchModels()
  } catch {
    // Offline / not connected — suggestions are simply skipped.
  }
}

watch(
  () => [props.editable, props.profile.id] as const,
  async () => {
    if (props.editable) {
      seedDraft()
      await Promise.all([loadDraftFields(), ensureModels()])
    }
  },
  { immediate: true }
)

function fieldsForFile(filename: string): OdooField[] {
  const model = modelForFile(filename)
  return (model && fieldsByModel.value.get(model)) || []
}

function baseField(row: FieldMapping): OdooField | undefined {
  for (const f of fieldsForFile(row.filename)) {
    if (f.name === baseFieldName(row.odooField)) return f
  }
  return undefined
}

async function onModelChange(file: DraftFile, model: string) {
  file.model = model
  dirty.value = true
  await ensureModelFields(model)
  // Re-derive transform/required for this file's rows under the new model.
  for (const row of draftFields.value) {
    if (row.filename !== file.filename) continue
    const meta = deriveFieldMetadata(baseField(row), row.odooField, row.csvHeader)
    row.transform = meta.transform
    row.required = meta.required
  }
}

function onFieldChange(row: FieldMapping, odooField: string) {
  row.odooField = odooField
  const meta = deriveFieldMetadata(
    fieldsForFile(row.filename).find((f) => f.name === baseFieldName(odooField)),
    odooField,
    row.csvHeader
  )
  row.transform = meta.transform
  row.required = meta.required
  dirty.value = true
}

function onTransformChange(row: FieldMapping, transform: FieldTransform) {
  row.transform = transform
  dirty.value = true
}

function onCsvHeaderChange(row: FieldMapping, value: string) {
  row.csvHeader = value
  dirty.value = true
}

function addFieldRow() {
  const filename = newFieldFile.value || draftFiles.value[0]?.filename
  if (!filename) return
  draftFields.value.push({
    filename,
    csvHeader: '',
    odooField: '',
    required: false,
    transform: { type: 'passthrough' },
    _uid: uidCounter++
  })
  dirty.value = true
}

function removeFieldRow(idx: number) {
  draftFields.value.splice(idx, 1)
  dirty.value = true
}

// ── File add / remove / rename / reorder ────────────────────────────
async function addFile() {
  const name = newFilename.value.trim()
  if (!name || draftFiles.value.some((f) => f.filename === name)) return
  const file: DraftFileRow = { filename: name, model: '', requires: [], extra: {}, _uid: uidCounter++ }
  draftFiles.value.push(file)
  newFilename.value = ''
  dirty.value = true
  // Auto-create the (empty) model mapping with a suggested target model.
  await ensureModels()
  const match = allModels.value.length ? suggestModel(name, allModels.value) : null
  if (match) await onModelChange(file, match.model.model)
}

/** Rename a file in place, keeping its field mappings in sync. */
function onFilenameChange(file: DraftFileRow, newName: string) {
  const old = file.filename
  if (newName === old) return
  file.filename = newName
  for (const row of draftFields.value) {
    if (row.filename === old) row.filename = newName
  }
  dirty.value = true
}

function removeFile(idx: number) {
  const [removed] = draftFiles.value.splice(idx, 1)
  if (removed) {
    draftFields.value = draftFields.value.filter((r) => r.filename !== removed.filename)
  }
  dirty.value = true
}

// Native HTML5 drag-and-drop reordering for the Reihenfolge tab.
const dragIndex = ref<number | null>(null)

function onDragStart(idx: number) {
  dragIndex.value = idx
}

function onDrop(idx: number) {
  const from = dragIndex.value
  dragIndex.value = null
  if (from === null || from === idx) return
  const arr = draftFiles.value
  const [moved] = arr.splice(from, 1)
  arr.splice(idx, 0, moved)
  dirty.value = true
}

function onDragEnd() {
  dragIndex.value = null
}

function updateSetting(key: string, value: unknown) {
  if (props.editable) {
    ;(draftSettings as Record<string, unknown>)[key] = value
    dirty.value = true
  } else {
    emit('update:runSettings', { [key]: value })
  }
}

const settingsForDisplay = computed<RunSettings>(() =>
  props.editable ? (draftSettings as RunSettings) : props.effectiveRunSettings
)

function onSave() {
  const { mappings, sequence } = buildFilesSaveData(draftFiles.value)
  // Drop blank rows and the internal _uid before serializing.
  const fieldRows: FieldMapping[] = draftFields.value
    .filter((r) => r.csvHeader.trim() || r.odooField.trim())
    .map((r) => ({
      filename: r.filename,
      csvHeader: r.csvHeader,
      odooField: r.odooField,
      required: r.required,
      transform: r.transform,
      ...(r.notes ? { notes: r.notes } : {})
    }))
  emit('save', {
    mappings,
    sequence,
    runSettings: { ...draftSettings },
    fieldMappings: fieldRows.length > 0 ? fieldRows : undefined
  })
}

function onCancel() {
  seedDraft()
}
</script>

<template>
  <div class="csv-profile-editor">
    <!-- Tab Buttons -->
    <div class="csv-profile-editor__tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="csv-profile-editor__tab"
        :class="{ 'csv-profile-editor__tab--active': activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
        <span
          v-if="isOverridden(tab.key)"
          class="csv-profile-editor__override-dot"
          :title="$t('profileEditor.hasOverrides')"
        ></span>
      </button>
    </div>

    <!-- Settings Tab -->
    <div v-show="activeTab === 'settings'" class="csv-profile-editor__content">
      <ProfileEditorSettings
        :effective-run-settings="settingsForDisplay"
        :run-config="runConfig"
        @update:setting="updateSetting"
      />
    </div>

    <!-- Sequence Tab (Reihenfolge) -->
    <div v-show="activeTab === 'sequence'" class="csv-profile-editor__content">
      <!-- Editable variant: drag the handle to reorder, rename, add, remove -->
      <template v-if="editable">
        <table v-if="draftFiles.length > 0" class="table table-sm small mb-2 align-middle">
          <thead>
            <tr>
              <th style="width: 2rem;"></th>
              <th class="text-start fw-medium" style="width: 3rem;">#</th>
              <th class="text-start fw-medium">{{ $t('profileEditor.filename') }}</th>
              <th class="text-center" style="width: 2rem;"></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(file, idx) in draftFiles"
              :key="file._uid"
              :class="{ 'csv-profile-editor__row--dragging': dragIndex === idx }"
              @dragover.prevent
              @drop="onDrop(idx)"
            >
              <td
                class="text-center csv-profile-editor__drag-handle"
                draggable="true"
                :title="$t('profileEditor.dragToReorder')"
                @dragstart="onDragStart(idx)"
                @dragend="onDragEnd"
              >⠿</td>
              <td class="text-body-secondary">{{ idx + 1 }}</td>
              <td>
                <input
                  :value="file.filename"
                  type="text"
                  class="form-control form-control-sm font-monospace"
                  style="font-size: 0.75rem;"
                  @input="onFilenameChange(file, ($event.target as HTMLInputElement).value)"
                />
              </td>
              <td class="text-center">
                <button
                  type="button"
                  class="btn btn-sm btn-link text-danger p-0"
                  :title="$t('common.remove')"
                  @click="removeFile(idx)"
                >&times;</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="text-center py-3 text-body-secondary small">
          {{ $t('profileEditor.noSequence') }}
        </div>
        <!-- Add-file control: a new file also gets an (empty, suggested) mapping -->
        <div class="d-flex gap-2 px-1">
          <input
            v-model="newFilename"
            type="text"
            class="form-control form-control-sm"
            :placeholder="$t('profileEditor.filenamePlaceholder')"
            @keyup.enter="addFile"
          />
          <button
            type="button"
            class="btn btn-sm btn-outline-primary text-nowrap"
            :disabled="!newFilename.trim()"
            @click="addFile"
          >
            {{ $t('profileEditor.addFile') }}
          </button>
        </div>
      </template>

      <!-- Read-only variant -->
      <template v-else>
        <div v-if="effectiveSequence.length === 0" class="text-center py-3 text-body-secondary small">
          {{ $t('profileEditor.noSequence') }}
        </div>
        <table v-else class="table table-sm small mb-0">
          <thead>
            <tr>
              <th class="text-start fw-medium" style="width: 4rem;">#</th>
              <th class="text-start fw-medium">{{ $t('profileEditor.filename') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in effectiveSequence" :key="item.filename">
              <td class="text-body-secondary">{{ item.order }}</td>
              <td class="font-monospace" style="font-size: 0.75rem;">{{ item.filename }}</td>
            </tr>
          </tbody>
        </table>
        <small v-if="hasSequenceOverride" class="text-warning d-block mt-2 px-3">
          {{ $t('profileEditor.sequenceOverridden') }}
        </small>
      </template>
    </div>

    <!-- Mappings Tab (Modelzuordnungen) -->
    <div v-show="activeTab === 'mappings'" class="csv-profile-editor__content">
      <!-- Editable variant: assign a target model per file. Files are added or
           removed on the Reihenfolge tab. -->
      <template v-if="editable">
        <table v-if="draftFiles.length > 0" class="table table-sm small mb-0 align-middle">
          <thead>
            <tr>
              <th class="text-start fw-medium">{{ $t('profileEditor.filename') }}</th>
              <th class="text-start fw-medium">{{ $t('profileEditor.model') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="file in draftFiles" :key="file._uid">
              <td class="font-monospace" style="font-size: 0.75rem;">{{ file.filename }}</td>
              <td style="min-width: 12rem;">
                <ModelSelect
                  :model-value="file.model || null"
                  @update:model-value="onModelChange(file, $event)"
                />
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="text-center py-3 text-body-secondary small">
          {{ $t('profileEditor.noMappings') }}
        </div>
      </template>

      <!-- Read-only variant -->
      <template v-else>
        <div v-if="effectiveMappings.length === 0" class="text-center py-3 text-body-secondary small">
          {{ $t('profileEditor.noMappings') }}
        </div>
        <table v-else class="table table-sm small mb-0">
          <thead>
            <tr>
              <th class="text-start fw-medium">{{ $t('profileEditor.filename') }}</th>
              <th class="text-start fw-medium">{{ $t('profileEditor.model') }}</th>
              <th class="text-center" style="width: 2rem;"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="mapping in effectiveMappings" :key="mapping.filename">
              <td class="font-monospace" style="font-size: 0.75rem;">{{ mapping.filename }}</td>
              <td style="font-size: 0.75rem;">{{ mapping.model }}</td>
              <td class="text-center">
                <span
                  v-if="runConfig.mappingsOverride.has(mapping.filename)"
                  class="csv-override-indicator"
                  :title="$t('profileEditor.overridden')"
                >*</span>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>

    <!-- Field Mappings Tab -->
    <div v-show="activeTab === 'field-mappings'" class="csv-profile-editor__content">
      <!-- Editable variant -->
      <template v-if="editable">
        <div v-if="loadingFields" class="text-center py-3 text-body-secondary small">
          {{ $t('common.loading') }}
        </div>
        <template v-else>
          <table v-if="draftFields.length > 0" class="table table-sm small mb-2 align-middle">
            <thead>
              <tr>
                <th class="text-start fw-medium">{{ $t('profileEditor.file') }}</th>
                <th class="text-start fw-medium">{{ $t('profileEditor.csvHeader') }}</th>
                <th class="text-start fw-medium">{{ $t('profileEditor.odooField') }}</th>
                <th class="text-center fw-medium" style="width: 3rem;">{{ $t('config.req') }}</th>
                <th class="text-start fw-medium">{{ $t('profileEditor.transform') }}</th>
                <th class="text-center" style="width: 2rem;"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in draftFields" :key="row._uid">
                <td class="font-monospace" style="font-size: 0.75rem;">{{ row.filename }}</td>
                <td style="min-width: 8rem;">
                  <input
                    :value="row.csvHeader"
                    type="text"
                    class="form-control form-control-sm"
                    style="font-size: 0.75rem;"
                    :placeholder="$t('profileEditor.csvHeaderPlaceholder')"
                    @input="onCsvHeaderChange(row, ($event.target as HTMLInputElement).value)"
                  />
                </td>
                <td style="min-width: 14rem;">
                  <div class="d-flex">
                    <FieldSelect
                      :model-value="row.odooField"
                      :fields="fieldsForFile(row.filename)"
                      @update:model-value="onFieldChange(row, $event)"
                    />
                  </div>
                </td>
                <td class="text-center">
                  <span v-if="row.required" class="text-warning">{{ $t('common.yes') }}</span>
                  <span v-else class="text-body-secondary">-</span>
                </td>
                <td>
                  <TransformSelect
                    :model-value="row.transform"
                    :relation-model="baseField(row)?.relation"
                    :field-type="baseField(row)?.type"
                    @update:model-value="onTransformChange(row, $event)"
                  />
                </td>
                <td class="text-center">
                  <button
                    type="button"
                    class="btn btn-sm btn-link text-danger p-0"
                    :title="$t('common.remove')"
                    @click="removeFieldRow(idx)"
                  >&times;</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="text-center py-3 text-body-secondary small">
            {{ $t('profileEditor.noFieldMappings') }}
          </div>
          <!-- Add-field-mapping control -->
          <div class="d-flex gap-2 px-1">
            <select
              v-model="newFieldFile"
              class="form-select form-select-sm"
              style="max-width: 16rem;"
              :disabled="draftFiles.length === 0"
            >
              <option v-for="file in draftFiles" :key="file._uid" :value="file.filename">
                {{ file.filename }}
              </option>
            </select>
            <button
              type="button"
              class="btn btn-sm btn-outline-primary text-nowrap"
              :disabled="draftFiles.length === 0"
              @click="addFieldRow"
            >
              {{ $t('profileEditor.addFieldMapping') }}
            </button>
          </div>
        </template>
      </template>

      <!-- Read-only variant -->
      <template v-else>
        <div v-if="fieldMappings.length === 0" class="text-center py-3 text-body-secondary small">
          {{ $t('profileEditor.noFieldMappings') }}
        </div>
        <table v-else class="table table-sm small mb-0">
          <thead>
            <tr>
              <th class="text-start fw-medium">{{ $t('profileEditor.file') }}</th>
              <th class="text-start fw-medium">{{ $t('profileEditor.csvHeader') }}</th>
              <th class="text-start fw-medium">{{ $t('profileEditor.odooField') }}</th>
              <th class="text-center fw-medium" style="width: 3rem;">{{ $t('config.req') }}</th>
              <th class="text-start fw-medium">{{ $t('profileEditor.transform') }}</th>
              <th class="text-center" style="width: 2rem;"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(fm, idx) in fieldMappings" :key="`${fm.filename}-${fm.csvHeader}-${idx}`">
              <td class="font-monospace" style="font-size: 0.75rem;">{{ fm.filename }}</td>
              <td style="font-size: 0.75rem;">{{ fm.csvHeader }}</td>
              <td class="font-monospace" style="font-size: 0.75rem;">{{ fm.odooField }}</td>
              <td class="text-center">
                <span v-if="fm.required" class="text-warning">{{ $t('common.yes') }}</span>
                <span v-else class="text-body-secondary">-</span>
              </td>
              <td class="text-body-secondary" style="font-size: 0.75rem;">
                {{ fm.transform ? serializeTransform(fm.transform) : '-' }}
              </td>
              <td class="text-center">
                <span
                  v-if="runConfig.fieldMappingsOverride.has(fm.filename)"
                  class="csv-override-indicator"
                  :title="$t('profileEditor.overridden')"
                >*</span>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>

    <!-- Editor footer -->
    <div v-if="editable" class="csv-profile-editor__footer">
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        :disabled="saving || !dirty"
        @click="onCancel"
      >
        {{ $t('common.cancel') }}
      </button>
      <button
        type="button"
        class="btn btn-sm btn-primary"
        :disabled="saving || !dirty"
        @click="onSave"
      >
        {{ saving ? $t('common.loading') : $t('common.save') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.csv-profile-editor {
  background: var(--bs-body-bg);
}
.csv-profile-editor__tabs {
  display: flex;
  border-bottom: 1px solid var(--bs-border-color);
  background: var(--bs-tertiary-bg);
}
.csv-profile-editor__tab {
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
.csv-profile-editor__tab:hover {
  color: var(--bs-body-color);
  background: var(--bs-secondary-bg-subtle);
}
.csv-profile-editor__tab--active {
  color: var(--bs-primary);
  border-bottom-color: var(--bs-primary);
}
.csv-profile-editor__override-dot {
  position: absolute;
  top: 0.375rem;
  right: 0.375rem;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--bs-warning);
}
.csv-profile-editor__content {
  padding: 0.75rem;
}
.csv-profile-editor__drag-handle {
  cursor: grab;
  color: var(--bs-secondary-color);
  user-select: none;
}
.csv-profile-editor__row--dragging {
  opacity: 0.5;
}
.csv-profile-editor__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem;
  border-top: 1px solid var(--bs-border-color);
  background: var(--bs-tertiary-bg);
}
.csv-override-indicator {
  color: var(--bs-warning);
  font-weight: bold;
}
</style>
