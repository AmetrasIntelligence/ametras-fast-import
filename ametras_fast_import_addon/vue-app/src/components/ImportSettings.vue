<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type RunSettings } from '@/stores/config'
import { usePlatformStore } from '@/stores/platform'
import { validateWorkerConfig } from '@/importer/workerPool'

const { t } = useI18n()
const config = useConfigStore()
const platform = usePlatformStore()

const workerWarning = computed(() => {
  const { warning } = validateWorkerConfig(config.settings.workers, config.settings.batchSize)
  return warning
})

const batchSizeMin = computed(() => platform.batchSizeRange.min)
const batchSizeMax = computed(() => platform.batchSizeRange.max)

const batchSizeError = computed(() => {
  const size = config.settings.batchSize
  if (size < batchSizeMin.value) return !platform.capabilities.multipleWorkers
    ? t('settings.validation.batchSizeStandaloneRange')
    : t('settings.validation.batchSizeMin')
  if (size > batchSizeMax.value) return !platform.capabilities.multipleWorkers
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
  if (workers > platform.maxWorkers) return t('settings.validation.workersMax')
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
  <div>
    <div class="row row-cols-1 row-cols-sm-2 g-3">
      <div>
        <label class="form-label small text-body-secondary mb-1">
          {{ $t('settings.batchSize') }}
          <span v-if="!platform.capabilities.multipleWorkers" class="text-body-secondary">({{ batchSizeMin }}-{{ batchSizeMax }})</span>
        </label>
        <input
          :value="config.settings.batchSize"
          type="number"
          :min="batchSizeMin"
          :max="batchSizeMax"
          class="form-control form-control-sm"
          :class="{ 'is-invalid': batchSizeError }"
          @input="config.setSettings({ batchSize: parseInt(($event.target as HTMLInputElement).value) || 100 })"
        />
        <div v-if="batchSizeError" class="invalid-feedback">
          {{ batchSizeError }}
        </div>
      </div>
      <div>
        <label class="form-label small text-body-secondary mb-1">
          {{ $t('settings.workers') }}
          <span class="text-body-secondary">(1-{{ platform.maxWorkers }})</span>
        </label>
        <input
          :value="config.settings.workers"
          type="number"
          min="1"
          :max="platform.maxWorkers"
          class="form-control form-control-sm"
          :class="{ 'is-invalid': workersError }"
          @input="config.setSettings({ workers: Math.max(1, Math.min(platform.maxWorkers, parseInt(($event.target as HTMLInputElement).value) || 1)) })"
        />
        <div v-if="workersError" class="invalid-feedback">
          {{ workersError }}
        </div>
        <small v-else-if="workerWarning" class="d-block text-warning mt-1">
          {{ workerWarning }}
        </small>
      </div>
      <div>
        <label class="form-label small text-body-secondary mb-1">{{ $t('settings.retryLimit') }}</label>
        <input
          :value="config.settings.retryLimit"
          type="number"
          min="0"
          max="10"
          class="form-control form-control-sm"
          :class="{ 'is-invalid': retryLimitError }"
          @input="config.setSettings({ retryLimit: parseInt(($event.target as HTMLInputElement).value) || 0 })"
        />
        <div v-if="retryLimitError" class="invalid-feedback">
          {{ retryLimitError }}
        </div>
      </div>
      <div>
        <label class="form-label small text-body-secondary mb-1">{{ $t('settings.retryDelayMs') }}</label>
        <input
          :value="config.settings.retryDelayMs"
          type="number"
          min="100"
          step="100"
          class="form-control form-control-sm"
          @input="config.setSettings({ retryDelayMs: parseInt(($event.target as HTMLInputElement).value) || 1000 })"
        />
      </div>
      <div class="d-flex align-items-center gap-2 pt-4">
        <input
          id="stopOnError"
          :checked="config.settings.stopOnFatalError"
          type="checkbox"
          class="form-check-input"
          @change="config.setSettings({ stopOnFatalError: ($event.target as HTMLInputElement).checked })"
        />
        <label for="stopOnError" class="form-check-label small">{{ $t('settings.stopOnFatalError') }}</label>
      </div>
    </div>

    <div class="row row-cols-1 row-cols-sm-2 g-3 mt-1">
      <div>
        <label class="form-label small text-body-secondary mb-1">{{ $t('settings.encoding') }}</label>
        <select
          :value="config.settings.encoding"
          class="form-select form-select-sm"
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
        <label class="form-label small text-body-secondary mb-1">{{ $t('settings.delimiter') }}</label>
        <select
          :value="config.settings.delimiter"
          class="form-select form-select-sm"
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
      <div class="d-flex align-items-center gap-2 pt-4">
        <input
          id="dryRun"
          :checked="!platform.capabilities.dryRun ? false : config.settings.dryRun"
          type="checkbox"
          class="form-check-input"
          :disabled="!platform.capabilities.dryRun"
          @change="config.setSettings({ dryRun: ($event.target as HTMLInputElement).checked })"
        />
        <label for="dryRun" class="form-check-label small" :class="{ 'text-body-secondary': !platform.capabilities.dryRun }">{{ $t('settings.dryRun') }}</label>
        <small v-if="!platform.capabilities.dryRun" class="text-body-secondary">{{ $t('settings.standalone.dryRunUnavailable') }}</small>
      </div>
      <div>
        <label class="form-label small text-body-secondary mb-1">{{ $t('settings.language') }}</label>
        <input
          :value="config.settings.lang"
          type="text"
          class="form-control form-control-sm"
          :placeholder="$t('settings.langPlaceholder')"
          :disabled="!platform.capabilities.lang"
          @input="config.setSettings({ lang: ($event.target as HTMLInputElement).value })"
        />
        <small v-if="!platform.capabilities.lang" class="d-block text-body-secondary mt-1">
          {{ $t('settings.standalone.langUnavailable') }}
        </small>
      </div>
    </div>
  </div>
</template>
