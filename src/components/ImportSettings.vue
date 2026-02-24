<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type RunSettings } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { validateWorkerConfig } from '@/importer/workerPool'
import { STANDALONE_MIN_BATCH_SIZE, STANDALONE_MAX_BATCH_SIZE } from '@/importer/standalone/executor'

const { t } = useI18n()
const config = useConfigStore()
const session = useSessionStore()

const isStandalone = computed(() => session.importMode === 'standalone')

const workerWarning = computed(() => {
  const { warning } = validateWorkerConfig(config.settings.workers, config.settings.batchSize)
  return warning
})

const batchSizeMin = computed(() => isStandalone.value ? STANDALONE_MIN_BATCH_SIZE : 1)
const batchSizeMax = computed(() => isStandalone.value ? STANDALONE_MAX_BATCH_SIZE : 1000)

const batchSizeError = computed(() => {
  const size = config.settings.batchSize
  if (size < batchSizeMin.value) return isStandalone.value
    ? t('settings.validation.batchSizeStandaloneRange')
    : t('settings.validation.batchSizeMin')
  if (size > batchSizeMax.value) return isStandalone.value
    ? t('settings.validation.batchSizeStandaloneRange')
    : t('settings.validation.batchSizeMax')
  return null
})

const retryLimitError = computed(() => {
  const limit = config.settings.retryLimit
  if (limit < 0) return t('settings.validation.retryLimitMin')
  if (limit > 10) return t('settings.validation.retryLimitMax')
  return null
})

const workersError = computed(() => {
  const workers = config.settings.workers
  if (workers < 1) return t('settings.validation.workersMin')
  if (workers > 4) return t('settings.validation.workersMax')
  return null
})

const delimiterOptions = computed(() => [
  { value: ',', label: t('settings.delimiter_options.comma') },
  { value: ';', label: t('settings.delimiter_options.semicolon') },
  { value: '\t', label: t('settings.delimiter_options.tab') },
  { value: '', label: t('settings.delimiter_options.auto') }
])

const encodingOptions = computed(() => [
  { value: 'utf-8', label: t('settings.encoding_options.utf-8') },
  { value: 'utf-8-sig', label: t('settings.encoding_options.utf-8-sig') },
  { value: 'latin-1', label: t('settings.encoding_options.latin-1') },
  { value: 'cp1252', label: t('settings.encoding_options.cp1252') }
])
</script>

<template>
  <div class="csv-settings-content">
    <div class="csv-grid csv-grid-cols-2 csv-gap-4">
      <div>
        <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">
          {{ $t('settings.batchSize') }}
          <span v-if="isStandalone" class="csv-text-muted">({{ batchSizeMin }}-{{ batchSizeMax }})</span>
        </label>
        <input
          :value="config.settings.batchSize"
          type="number"
          :min="batchSizeMin"
          :max="batchSizeMax"
          class="csv-settings-input"
          :class="{ 'csv-settings-input--error': batchSizeError }"
          @input="config.setSettings({ batchSize: parseInt(($event.target as HTMLInputElement).value) || 100 })"
        />
        <span v-if="batchSizeError" class="csv-text-xs csv-text-red-600 csv-mt-1 csv-block">
          {{ batchSizeError }}
        </span>
      </div>
      <div>
        <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">
          {{ $t('settings.workers') }}
          <span v-if="!isStandalone" class="csv-text-muted">{{ $t('settings.workersRange') }}</span>
        </label>
        <input
          :value="isStandalone ? 1 : config.settings.workers"
          type="number"
          min="1"
          max="4"
          class="csv-settings-input"
          :class="{ 'csv-settings-input--error': workersError }"
          :disabled="isStandalone"
          @input="config.setSettings({ workers: Math.max(1, Math.min(4, parseInt(($event.target as HTMLInputElement).value) || 1)) })"
        />
        <span v-if="isStandalone" class="csv-text-xs csv-text-muted csv-mt-1 csv-block">
          {{ $t('settings.standalone.workersFixed') }}
        </span>
        <span v-else-if="workersError" class="csv-text-xs csv-text-red-600 csv-mt-1 csv-block">
          {{ workersError }}
        </span>
        <span v-else-if="workerWarning" class="csv-text-xs csv-text-amber-600 csv-mt-1 csv-block">
          {{ workerWarning }}
        </span>
      </div>
      <div>
        <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">{{ $t('settings.retryLimit') }}</label>
        <input
          :value="config.settings.retryLimit"
          type="number"
          min="0"
          max="10"
          class="csv-settings-input"
          :class="{ 'csv-settings-input--error': retryLimitError }"
          @input="config.setSettings({ retryLimit: parseInt(($event.target as HTMLInputElement).value) || 0 })"
        />
        <span v-if="retryLimitError" class="csv-text-xs csv-text-red-600 csv-mt-1 csv-block">
          {{ retryLimitError }}
        </span>
      </div>
      <div>
        <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">{{ $t('settings.retryDelayMs') }}</label>
        <input
          :value="config.settings.retryDelayMs"
          type="number"
          min="100"
          step="100"
          class="csv-settings-input"
          @input="config.setSettings({ retryDelayMs: parseInt(($event.target as HTMLInputElement).value) || 1000 })"
        />
      </div>
      <div class="csv-flex csv-items-center csv-gap-2 csv-pt-4">
        <input
          :checked="config.settings.stopOnFatalError"
          type="checkbox"
          id="stopOnError"
          @change="config.setSettings({ stopOnFatalError: ($event.target as HTMLInputElement).checked })"
        />
        <label for="stopOnError" class="csv-text-sm">{{ $t('settings.stopOnFatalError') }}</label>
      </div>
    </div>

    <div class="csv-grid csv-grid-cols-2 csv-gap-4 csv-mt-4">
      <div>
        <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">{{ $t('settings.encoding') }}</label>
        <select
          :value="config.settings.encoding"
          class="csv-settings-input"
          @change="config.setSettings({ encoding: ($event.target as HTMLSelectElement).value as RunSettings['encoding'] })"
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
        <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">{{ $t('settings.delimiter') }}</label>
        <select
          :value="config.settings.delimiter"
          class="csv-settings-input"
          @change="config.setSettings({ delimiter: ($event.target as HTMLSelectElement).value as RunSettings['delimiter'] })"
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
          :checked="config.settings.skipHeader"
          type="checkbox"
          id="skipHeader"
          @change="config.setSettings({ skipHeader: ($event.target as HTMLInputElement).checked })"
        />
        <label for="skipHeader" class="csv-text-sm">{{ $t('settings.skipHeader') }}</label>
      </div>
      <div class="csv-flex csv-items-center csv-gap-2 csv-pt-4">
        <input
          :checked="isStandalone ? false : config.settings.dryRun"
          type="checkbox"
          id="dryRun"
          :disabled="isStandalone"
          @change="config.setSettings({ dryRun: ($event.target as HTMLInputElement).checked })"
        />
        <label for="dryRun" class="csv-text-sm" :class="{ 'csv-text-muted': isStandalone }">{{ $t('settings.dryRun') }}</label>
        <span v-if="isStandalone" class="csv-text-xs csv-text-muted">{{ $t('settings.standalone.dryRunUnavailable') }}</span>
      </div>
      <div>
        <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">{{ $t('settings.language') }}</label>
        <input
          :value="config.settings.lang"
          type="text"
          class="csv-settings-input"
          placeholder="e.g. de_DE"
          :disabled="isStandalone"
          @input="config.setSettings({ lang: ($event.target as HTMLInputElement).value })"
        />
        <span v-if="isStandalone" class="csv-text-xs csv-text-muted csv-mt-1 csv-block">
          {{ $t('settings.standalone.langUnavailable') }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
.csv-text-amber-600 {
  color: #d97706;
}
.csv-text-red-600 {
  color: #dc2626;
}
.csv-settings-input--error {
  border-color: #dc2626;
}
.csv-settings-input--error:focus {
  border-color: #dc2626;
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.2);
}
.csv-settings-input:disabled,
input[type="checkbox"]:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
