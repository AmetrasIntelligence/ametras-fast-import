<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ImportProfile, ProfileCreateData } from '@/types/importProfile'
import type { RunConfig } from '@/types/runConfig'
import type { RunSettings } from '@/stores/config'
import type { FieldMapping, FieldTransform } from '@/types/fieldMapping'
import { serializeTransform } from '@/types/fieldMapping'
import { fetchModelFields, type OdooField } from '@/api/odooClient'
import { baseFieldName, deriveFieldMetadata } from '@/utils/fieldMetadata'
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

type Tab = 'settings' | 'mappings' | 'sequence' | 'field-mappings'
const activeTab = ref<Tab>('settings')

const tabs = computed(() => [
  { key: 'settings' as Tab, label: t('profileEditor.tabs.settings') },
  { key: 'mappings' as Tab, label: t('profileEditor.tabs.mappings') },
  { key: 'sequence' as Tab, label: t('profileEditor.tabs.sequence') },
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
const draftModels = reactive<Record<string, string>>({})
const draftFields = ref<FieldMapping[]>([])
const draftSettings = reactive<Partial<RunSettings>>({})
const fieldsByModel = ref<Map<string, OdooField[]>>(new Map())
const loadingFields = ref(false)
const dirty = ref(false)

function seedDraft() {
  for (const key of Object.keys(draftModels)) delete draftModels[key]
  for (const m of props.profile.mappings) draftModels[m.filename] = m.model

  draftFields.value = (props.profile.richFieldMappings || []).map((fm) => ({
    filename: fm.filename,
    csvHeader: fm.csvHeader,
    odooField: fm.odooField,
    required: fm.required,
    transform: { ...fm.transform } as FieldTransform,
    ...(fm.notes ? { notes: fm.notes } : {})
  }))

  for (const key of Object.keys(draftSettings)) {
    delete (draftSettings as Record<string, unknown>)[key]
  }
  Object.assign(draftSettings, props.profile.runSettings)
  dirty.value = false
}

async function ensureModelFields(model: string) {
  if (model && !fieldsByModel.value.has(model)) {
    fieldsByModel.value.set(model, await fetchModelFields(model))
  }
}

async function loadDraftFields() {
  loadingFields.value = true
  try {
    for (const model of new Set(Object.values(draftModels).filter(Boolean))) {
      await ensureModelFields(model)
    }
  } finally {
    loadingFields.value = false
  }
}

watch(
  () => [props.editable, props.profile.id] as const,
  async () => {
    if (props.editable) {
      seedDraft()
      await loadDraftFields()
    }
  },
  { immediate: true }
)

function fieldsForFile(filename: string): OdooField[] {
  const model = draftModels[filename]
  return (model && fieldsByModel.value.get(model)) || []
}

function baseField(row: FieldMapping): OdooField | undefined {
  for (const f of fieldsForFile(row.filename)) {
    if (f.name === baseFieldName(row.odooField)) return f
  }
  return undefined
}

async function onModelChange(filename: string, model: string) {
  draftModels[filename] = model
  dirty.value = true
  await ensureModelFields(model)
  // Re-derive transform/required for this file's rows under the new model.
  for (const row of draftFields.value) {
    if (row.filename !== filename) continue
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

function removeFieldRow(idx: number) {
  draftFields.value.splice(idx, 1)
  dirty.value = true
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
  const mappings = props.profile.mappings.map((m) => ({
    ...m,
    model: draftModels[m.filename] ?? m.model
  }))
  emit('save', {
    mappings,
    sequence: props.profile.sequence,
    runSettings: { ...draftSettings },
    fieldMappings:
      draftFields.value.length > 0 ? draftFields.value.map((r) => ({ ...r })) : undefined
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

    <!-- Mappings Tab -->
    <div v-show="activeTab === 'mappings'" class="csv-profile-editor__content">
      <div v-if="effectiveMappings.length === 0" class="text-center py-3 text-body-secondary small">
        {{ $t('profileEditor.noMappings') }}
      </div>
      <table v-else class="table table-sm small mb-0">
        <thead>
          <tr>
            <th class="text-start fw-medium">{{ $t('profileEditor.filename') }}</th>
            <th class="text-start fw-medium">{{ $t('profileEditor.model') }}</th>
            <th v-if="!editable" class="text-center" style="width: 2rem;"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="mapping in effectiveMappings" :key="mapping.filename">
            <td class="font-monospace" style="font-size: 0.75rem;">{{ mapping.filename }}</td>
            <td v-if="editable" style="min-width: 12rem;">
              <ModelSelect
                :model-value="draftModels[mapping.filename] || null"
                @update:model-value="onModelChange(mapping.filename, $event)"
              />
            </td>
            <td v-else style="font-size: 0.75rem;">{{ mapping.model }}</td>
            <td v-if="!editable" class="text-center">
              <span
                v-if="runConfig.mappingsOverride.has(mapping.filename)"
                class="csv-override-indicator"
                :title="$t('profileEditor.overridden')"
              >*</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Sequence Tab (display only) -->
    <div v-show="activeTab === 'sequence'" class="csv-profile-editor__content">
      <div v-if="effectiveSequence.length === 0" class="text-center py-3 text-body-secondary small">
        {{ $t('profileEditor.noSequence') }}
      </div>
      <table v-else class="table table-sm small mb-0">
        <thead>
          <tr>
            <th class="text-start fw-medium" style="width: 4rem;">#</th>
            <th class="text-start fw-medium">{{ $t('profileEditor.filename') }}</th>
            <th class="text-start fw-medium">{{ $t('profileEditor.requires') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in effectiveSequence" :key="item.filename">
            <td class="text-body-secondary">{{ item.order }}</td>
            <td class="font-monospace" style="font-size: 0.75rem;">{{ item.filename }}</td>
            <td class="text-body-secondary" style="font-size: 0.75rem;">
              {{ item.requires?.join(', ') || '-' }}
            </td>
          </tr>
        </tbody>
      </table>
      <small v-if="hasSequenceOverride" class="text-warning d-block mt-2 px-3">
        {{ $t('profileEditor.sequenceOverridden') }}
      </small>
    </div>

    <!-- Field Mappings Tab -->
    <div v-show="activeTab === 'field-mappings'" class="csv-profile-editor__content">
      <!-- Editable variant -->
      <template v-if="editable">
        <div v-if="loadingFields" class="text-center py-3 text-body-secondary small">
          {{ $t('common.loading') }}
        </div>
        <div v-else-if="draftFields.length === 0" class="text-center py-3 text-body-secondary small">
          {{ $t('profileEditor.noFieldMappings') }}
        </div>
        <table v-else class="table table-sm small mb-0 align-middle">
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
            <tr v-for="(row, idx) in draftFields" :key="`${row.filename}-${row.csvHeader}-${idx}`">
              <td class="font-monospace" style="font-size: 0.75rem;">{{ row.filename }}</td>
              <td style="font-size: 0.75rem;">{{ row.csvHeader }}</td>
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
