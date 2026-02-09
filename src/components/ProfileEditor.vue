<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ImportProfile } from '@/types/importProfile'
import type { RunConfig } from '@/types/runConfig'
import type { RunSettings } from '@/stores/config'
import { serializeTransform } from '@/types/fieldMapping'
import { Button } from '@/ui'

const { t } = useI18n()

const props = defineProps<{
  profile: ImportProfile
  runConfig: RunConfig
  effectiveRunSettings: RunSettings
  effectiveMappings: ImportProfile['mappings']
  effectiveSequence: ImportProfile['sequence']
  hasOverrides: boolean
}>()

const emit = defineEmits<{
  'update:runSettings': [overrides: Partial<RunSettings>]
  'reset-all': []
}>()

type Tab = 'settings' | 'mappings' | 'sequence' | 'field-mappings'
const activeTab = ref<Tab>('settings')

// Note: Tab labels use computed for reactivity with i18n
const tabs = computed(() => [
  { key: 'settings' as Tab, label: t('profileEditor.tabs.settings') },
  { key: 'mappings' as Tab, label: t('profileEditor.tabs.mappings') },
  { key: 'sequence' as Tab, label: t('profileEditor.tabs.sequence') },
  { key: 'field-mappings' as Tab, label: t('profileEditor.tabs.fieldMappings') }
])

const hasSettingsOverrides = computed(() =>
  Object.keys(props.runConfig.runSettingsOverride).length > 0
)

const hasMappingsOverrides = computed(() =>
  props.runConfig.mappingsOverride.size > 0
)

const hasSequenceOverride = computed(() =>
  props.runConfig.sequenceOverride !== null
)

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

function isSettingOverridden(key: string): boolean {
  return key in props.runConfig.runSettingsOverride
}

const delimiterOptions = [
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: '\t', label: 'Tab' },
  { value: '', label: 'Auto-detect' }
]

const encodingOptions = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-8-sig', label: 'UTF-8 BOM' },
  { value: 'latin-1', label: 'Latin-1' },
  { value: 'cp1252', label: 'CP1252 (Windows)' }
]

function updateSetting(key: string, value: unknown) {
  emit('update:runSettings', { [key]: value })
}

const fieldMappings = computed(() => props.profile.richFieldMappings || [])
</script>

<template>
  <div class="csv-profile-editor">
    <!-- Header -->
    <div class="csv-profile-editor__header">
      <div>
        <h3 class="csv-font-medium csv-text-sm">{{ profile.name }}</h3>
        <span class="csv-text-xs csv-text-muted">
          v{{ profile.version }}
          <template v-if="profile.description"> &middot; {{ profile.description }}</template>
        </span>
      </div>
      <Button
        v-if="hasOverrides"
        variant="ghost"
        size="sm"
        @click="emit('reset-all')"
      >
        {{ $t('profileEditor.resetAll') }}
      </Button>
    </div>

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
      <div class="csv-grid csv-grid-cols-2 csv-gap-4">
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">
            Batch Size
            <span v-if="isSettingOverridden('batchSize')" class="csv-override-indicator">*</span>
          </label>
          <input
            :value="effectiveRunSettings.batchSize"
            type="number"
            min="1"
            max="1000"
            class="csv-settings-input"
            @input="updateSetting('batchSize', parseInt(($event.target as HTMLInputElement).value) || 100)"
          />
        </div>
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">
            Retry Limit
            <span v-if="isSettingOverridden('retryLimit')" class="csv-override-indicator">*</span>
          </label>
          <input
            :value="effectiveRunSettings.retryLimit"
            type="number"
            min="0"
            max="10"
            class="csv-settings-input"
            @input="updateSetting('retryLimit', parseInt(($event.target as HTMLInputElement).value) || 0)"
          />
        </div>
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">
            Retry Delay (ms)
            <span v-if="isSettingOverridden('retryDelayMs')" class="csv-override-indicator">*</span>
          </label>
          <input
            :value="effectiveRunSettings.retryDelayMs"
            type="number"
            min="100"
            step="100"
            class="csv-settings-input"
            @input="updateSetting('retryDelayMs', parseInt(($event.target as HTMLInputElement).value) || 1000)"
          />
        </div>
        <div class="csv-flex csv-items-center csv-gap-2 csv-pt-4">
          <input
            :checked="effectiveRunSettings.stopOnFatalError"
            type="checkbox"
            id="pe-stopOnError"
            @change="updateSetting('stopOnFatalError', ($event.target as HTMLInputElement).checked)"
          />
          <label for="pe-stopOnError" class="csv-text-sm">
            Stop on fatal error
            <span v-if="isSettingOverridden('stopOnFatalError')" class="csv-override-indicator">*</span>
          </label>
        </div>
      </div>

      <div class="csv-grid csv-grid-cols-2 csv-gap-4 csv-mt-4">
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">
            Encoding
            <span v-if="isSettingOverridden('encoding')" class="csv-override-indicator">*</span>
          </label>
          <select
            :value="effectiveRunSettings.encoding"
            class="csv-settings-input"
            @change="updateSetting('encoding', ($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="opt in encodingOptions"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">
            Delimiter
            <span v-if="isSettingOverridden('delimiter')" class="csv-override-indicator">*</span>
          </label>
          <select
            :value="effectiveRunSettings.delimiter"
            class="csv-settings-input"
            @change="updateSetting('delimiter', ($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="opt in delimiterOptions"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div class="csv-flex csv-items-center csv-gap-2 csv-pt-4">
          <input
            :checked="effectiveRunSettings.skipHeader"
            type="checkbox"
            id="pe-skipHeader"
            @change="updateSetting('skipHeader', ($event.target as HTMLInputElement).checked)"
          />
          <label for="pe-skipHeader" class="csv-text-sm">
            Skip header row
            <span v-if="isSettingOverridden('skipHeader')" class="csv-override-indicator">*</span>
          </label>
        </div>
        <div class="csv-flex csv-items-center csv-gap-2 csv-pt-4">
          <input
            :checked="effectiveRunSettings.dryRun"
            type="checkbox"
            id="pe-dryRun"
            @change="updateSetting('dryRun', ($event.target as HTMLInputElement).checked)"
          />
          <label for="pe-dryRun" class="csv-text-sm">
            Dry run (validate only)
            <span v-if="isSettingOverridden('dryRun')" class="csv-override-indicator">*</span>
          </label>
        </div>
      </div>
      <div class="csv-grid csv-grid-cols-2 csv-gap-4 csv-mt-4">
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">
            Language
            <span v-if="isSettingOverridden('lang')" class="csv-override-indicator">*</span>
          </label>
          <input
            :value="effectiveRunSettings.lang"
            type="text"
            class="csv-settings-input"
            placeholder="e.g. de_DE"
            @input="updateSetting('lang', ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
    </div>

    <!-- Mappings Tab -->
    <div v-show="activeTab === 'mappings'" class="csv-profile-editor__content">
      <div v-if="effectiveMappings.length === 0" class="csv-text-center csv-py-4 csv-text-muted csv-text-sm">
        {{ $t('profileEditor.noMappings') }}
      </div>
      <table v-else class="csv-w-full csv-text-sm">
        <thead>
          <tr class="csv-profile-editor__table-header">
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium">{{ $t('profileEditor.filename') }}</th>
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium">{{ $t('profileEditor.model') }}</th>
            <th class="csv-text-center csv-px-3 csv-py-2 csv-w-8"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="mapping in effectiveMappings"
            :key="mapping.filename"
            class="csv-profile-editor__table-row"
          >
            <td class="csv-px-3 csv-py-2 csv-font-mono csv-text-xs">{{ mapping.filename }}</td>
            <td class="csv-px-3 csv-py-2 csv-text-xs">{{ mapping.model }}</td>
            <td class="csv-text-center csv-px-3 csv-py-2">
              <span
                v-if="runConfig.mappingsOverride.has(mapping.filename)"
                class="csv-override-indicator"
                title="Overridden"
              >*</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Sequence Tab -->
    <div v-show="activeTab === 'sequence'" class="csv-profile-editor__content">
      <div v-if="effectiveSequence.length === 0" class="csv-text-center csv-py-4 csv-text-muted csv-text-sm">
        {{ $t('profileEditor.noSequence') }}
      </div>
      <table v-else class="csv-w-full csv-text-sm">
        <thead>
          <tr class="csv-profile-editor__table-header">
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium csv-w-16">#</th>
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium">{{ $t('profileEditor.filename') }}</th>
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium">{{ $t('profileEditor.requires') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in effectiveSequence"
            :key="item.filename"
            class="csv-profile-editor__table-row"
          >
            <td class="csv-px-3 csv-py-2 csv-text-muted">{{ item.order }}</td>
            <td class="csv-px-3 csv-py-2 csv-font-mono csv-text-xs">{{ item.filename }}</td>
            <td class="csv-px-3 csv-py-2 csv-text-xs csv-text-muted">
              {{ item.requires?.join(', ') || '-' }}
            </td>
          </tr>
        </tbody>
      </table>
      <div
        v-if="hasSequenceOverride"
        class="csv-text-xs csv-text-orange-600 csv-mt-2 csv-px-3"
      >
        {{ $t('profileEditor.sequenceOverridden') }}
      </div>
    </div>

    <!-- Field Mappings Tab -->
    <div v-show="activeTab === 'field-mappings'" class="csv-profile-editor__content">
      <div v-if="fieldMappings.length === 0" class="csv-text-center csv-py-4 csv-text-muted csv-text-sm">
        {{ $t('profileEditor.noFieldMappings') }}
      </div>
      <table v-else class="csv-w-full csv-text-sm">
        <thead>
          <tr class="csv-profile-editor__table-header">
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium">File</th>
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium">CSV Header</th>
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium">Odoo Field</th>
            <th class="csv-text-center csv-px-3 csv-py-2 csv-font-medium csv-w-12">Req</th>
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium">Transform</th>
            <th class="csv-text-center csv-px-3 csv-py-2 csv-w-8"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(fm, idx) in fieldMappings"
            :key="`${fm.filename}-${fm.csvHeader}-${idx}`"
            class="csv-profile-editor__table-row"
          >
            <td class="csv-px-3 csv-py-2 csv-font-mono csv-text-xs">{{ fm.filename }}</td>
            <td class="csv-px-3 csv-py-2 csv-text-xs">{{ fm.csvHeader }}</td>
            <td class="csv-px-3 csv-py-2 csv-font-mono csv-text-xs">{{ fm.odooField }}</td>
            <td class="csv-text-center csv-px-3 csv-py-2">
              <span v-if="fm.required" class="csv-text-orange-600">Yes</span>
              <span v-else class="csv-text-muted">-</span>
            </td>
            <td class="csv-px-3 csv-py-2 csv-text-xs csv-text-muted">
              {{ fm.transform ? serializeTransform(fm.transform) : '-' }}
            </td>
            <td class="csv-text-center csv-px-3 csv-py-2">
              <span
                v-if="runConfig.fieldMappingsOverride.has(fm.filename)"
                class="csv-override-indicator"
                title="Overridden"
              >*</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.csv-profile-editor {
  border: 1px solid #e5e7eb;
  border-radius: var(--radius, 0.375rem);
  background: white;
}
.csv-profile-editor__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem;
  border-bottom: 1px solid #e5e7eb;
}
.csv-profile-editor__tabs {
  display: flex;
  border-bottom: 1px solid #e5e7eb;
  background: #f9fafb;
}
.csv-profile-editor__tab {
  position: relative;
  padding: 0.5rem 1rem;
  border: none;
  background: none;
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
  color: #6b7280;
  border-bottom: 2px solid transparent;
}
.csv-profile-editor__tab:hover {
  color: #111827;
  background: #f3f4f6;
}
.csv-profile-editor__tab--active {
  color: #2563eb;
  border-bottom-color: #2563eb;
}
.csv-profile-editor__override-dot {
  position: absolute;
  top: 0.375rem;
  right: 0.375rem;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: #f97316;
}
.csv-profile-editor__content {
  padding: 0.75rem;
}
.csv-profile-editor__table-header {
  background: #f9fafb;
}
.csv-profile-editor__table-row {
  border-top: 1px solid #e5e7eb;
}
.csv-override-indicator {
  color: #f97316;
  font-weight: bold;
}
.csv-settings-input {
  width: 100%;
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.875rem;
  font-family: inherit;
}
.csv-settings-input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}
.csv-text-orange-600 {
  color: #ea580c;
}
</style>
