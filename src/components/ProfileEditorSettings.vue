<script setup lang="ts">
import type { RunSettings } from '@/stores/config'
import type { RunConfig } from '@/types/runConfig'

const props = defineProps<{
  effectiveRunSettings: RunSettings
  runConfig: RunConfig
}>()

const emit = defineEmits<{
  'update:setting': [key: string, value: unknown]
}>()

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
  emit('update:setting', key, value)
}
</script>

<template>
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
</template>

<style scoped>
.csv-override-indicator {
  color: #f97316;
  font-weight: bold;
}
.csv-settings-input {
  width: 100%;
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid var(--csv-color-border, #d1d5db);
  border-radius: var(--radius, 0.375rem);
  font-size: 0.875rem;
  font-family: inherit;
}
.csv-settings-input:focus {
  outline: none;
  border-color: var(--csv-color-primary, #2563eb);
  box-shadow: 0 0 0 2px var(--csv-color-primary-ring, rgba(37, 99, 235, 0.2));
}
</style>
