<script setup lang="ts">
import type { RunSettings } from '@/stores/config'
import type { RunConfig } from '@/types/runConfig'
import { useSettingsOptions } from '@/composables/useSettingsOptions'

const { delimiterOptions, encodingOptions } = useSettingsOptions()

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

function updateSetting(key: string, value: unknown) {
  emit('update:setting', key, value)
}
</script>

<template>
  <div class="row row-cols-1 row-cols-sm-2 g-3">
    <div>
      <label class="form-label small text-body-secondary mb-1">
        {{ $t('settings.batchSize') }}
        <span v-if="isSettingOverridden('batchSize')" class="csv-override-indicator">*</span>
      </label>
      <input
        :value="effectiveRunSettings.batchSize"
        type="number"
        min="1"
        max="1000"
        class="form-control form-control-sm"
        @input="{ const v = parseInt(($event.target as HTMLInputElement).value); if (!isNaN(v)) updateSetting('batchSize', v) }"
      />
    </div>
  </div>

  <div class="row row-cols-1 row-cols-sm-2 g-3 mt-1">
    <div>
      <label class="form-label small text-body-secondary mb-1">
        {{ $t('settings.encoding') }}
        <span v-if="isSettingOverridden('encoding')" class="csv-override-indicator">*</span>
      </label>
      <select
        :value="effectiveRunSettings.encoding"
        class="form-select form-select-sm"
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
      <label class="form-label small text-body-secondary mb-1">
        {{ $t('settings.delimiter') }}
        <span v-if="isSettingOverridden('delimiter')" class="csv-override-indicator">*</span>
      </label>
      <select
        :value="effectiveRunSettings.delimiter"
        class="form-select form-select-sm"
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
    <div class="d-flex align-items-center gap-2 pt-4">
      <input
        id="pe-skipHeader"
        :checked="effectiveRunSettings.skipHeader"
        type="checkbox"
        class="form-check-input"
        @change="updateSetting('skipHeader', ($event.target as HTMLInputElement).checked)"
      />
      <label for="pe-skipHeader" class="form-check-label small">
        {{ $t('settings.skipHeader') }}
        <span v-if="isSettingOverridden('skipHeader')" class="csv-override-indicator">*</span>
      </label>
    </div>
    <div class="d-flex align-items-center gap-2 pt-4">
      <input
        id="pe-dryRun"
        :checked="effectiveRunSettings.dryRun"
        type="checkbox"
        class="form-check-input"
        @change="updateSetting('dryRun', ($event.target as HTMLInputElement).checked)"
      />
      <label for="pe-dryRun" class="form-check-label small">
        {{ $t('settings.dryRun') }}
        <span v-if="isSettingOverridden('dryRun')" class="csv-override-indicator">*</span>
      </label>
    </div>
    <div class="d-flex align-items-center gap-2 pt-4">
      <input
        id="pe-autoValidate"
        :checked="effectiveRunSettings.autoValidate"
        type="checkbox"
        class="form-check-input"
        @change="updateSetting('autoValidate', ($event.target as HTMLInputElement).checked)"
      />
      <label for="pe-autoValidate" class="form-check-label small">
        {{ $t('settings.autoValidate') }}
        <span v-if="isSettingOverridden('autoValidate')" class="csv-override-indicator">*</span>
      </label>
    </div>
  </div>
  <div class="row row-cols-1 row-cols-sm-2 g-3 mt-1">
    <div>
      <label class="form-label small text-body-secondary mb-1">
        {{ $t('settings.language') }}
        <span v-if="isSettingOverridden('lang')" class="csv-override-indicator">*</span>
      </label>
      <input
        :value="effectiveRunSettings.lang"
        type="text"
        class="form-control form-control-sm"
        placeholder="e.g. de_DE"
        @input="updateSetting('lang', ($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>

<style scoped>
.csv-override-indicator {
  color: var(--bs-warning);
  font-weight: bold;
}
</style>
