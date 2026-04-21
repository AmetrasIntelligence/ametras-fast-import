<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type RunSettings } from '@/stores/config'
import { usePlatformStore } from '@/stores/platform'

const { t } = useI18n()
const config = useConfigStore()
const platform = usePlatformStore()

function validateWorkerConfig(workers: number, batchSize: number): { valid: boolean; warning?: string } {
  if (workers > 2 && batchSize < 50) {
    return { valid: true, warning: 'Workers may be inefficient with small batch sizes (< 50 rows)' }
  }
  if (workers > 4) {
    return { valid: false, warning: 'Maximum 4 workers allowed' }
  }
  return { valid: true }
}

// Server-side import: batch size and workers are hints for the backend
const BATCH_SIZE_MIN = 10
const BATCH_SIZE_MAX = 1000
const MAX_WORKERS = 4

const workerWarning = computed(() => {
  const { warning } = validateWorkerConfig(config.settings.workers, config.settings.batchSize)
  return warning
})

const batchSizeMin = computed(() => BATCH_SIZE_MIN)
const batchSizeMax = computed(() => BATCH_SIZE_MAX)

const batchSizeError = computed(() => {
  const size = config.settings.batchSize
  if (size < BATCH_SIZE_MIN) return t('settings.validation.batchSizeMin')
  if (size > BATCH_SIZE_MAX) return t('settings.validation.batchSizeMax')
  return null
})

const workersError = computed(() => {
  const workers = config.settings.workers
  if (workers < 1) return t('settings.validation.workersMin')
  if (workers > MAX_WORKERS) return t('settings.validation.workersMax')
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
          <span v-if="!true" class="text-body-secondary">({{ batchSizeMin }}-{{ batchSizeMax }})</span>
        </label>
        <input
          :value="config.settings.batchSize"
          type="number"
          :min="batchSizeMin"
          :max="batchSizeMax"
          class="form-control form-control-sm"
          :class="{ 'is-invalid': batchSizeError }"
          @input="{ const v = parseInt(($event.target as HTMLInputElement).value); if (!isNaN(v)) config.setSettings({ batchSize: v }) }"
        />
        <div v-if="batchSizeError" class="invalid-feedback">
          {{ batchSizeError }}
        </div>
      </div>
      <div>
        <label class="form-label small text-body-secondary mb-1">
          {{ $t('settings.workers') }}
          <span class="text-body-secondary">(1-{{ MAX_WORKERS }})</span>
        </label>
        <input
          :value="config.settings.workers"
          type="number"
          min="1"
          :max="MAX_WORKERS"
          class="form-control form-control-sm"
          :class="{ 'is-invalid': workersError }"
          @input="config.setSettings({ workers: Math.max(1, Math.min(MAX_WORKERS, parseInt(($event.target as HTMLInputElement).value) || 1)) })"
        />
        <div v-if="workersError" class="invalid-feedback">
          {{ workersError }}
        </div>
        <small v-else-if="workerWarning" class="d-block text-warning mt-1">
          {{ workerWarning }}
        </small>
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
