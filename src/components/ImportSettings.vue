<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '@/stores/config'
import { validateWorkerConfig } from '@/importer/workerPool'

const { t } = useI18n()
const config = useConfigStore()

// Local state only, not persisted
const isExpanded = ref(false)

const settingsSummary = computed(() => {
  const s = config.settings
  const parts = [
    `${t('settings.summary.batch')}: ${s.batchSize}`,
    s.workers > 1 ? `${t('settings.summary.workers')}: ${s.workers}` : null,
    `${t('settings.summary.retries')}: ${s.retryLimit}`,
    `${t('settings.summary.encoding')}: ${s.encoding}`,
    `${t('settings.summary.stopOnError')}: ${s.stopOnFatalError ? t('common.yes') : t('common.no')}`
  ].filter(Boolean)
  if (s.dryRun) parts.push(t('settings.summary.dryRun'))
  return parts.join(' | ')
})

const workerWarning = computed(() => {
  const { warning } = validateWorkerConfig(config.settings.workers, config.settings.batchSize)
  return warning
})

const batchSizeError = computed(() => {
  const size = config.settings.batchSize
  if (size < 1) return t('settings.validation.batchSizeMin')
  if (size > 1000) return t('settings.validation.batchSizeMax')
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
</script>

<template>
  <div class="csv-settings-panel">
    <!-- Header (always visible) -->
    <button
      type="button"
      class="csv-settings-panel__header"
      @click="isExpanded = !isExpanded"
    >
      <div class="csv-flex csv-items-center csv-gap-2">
        <svg
          class="csv-settings-panel__chevron"
          :class="{ 'csv-settings-panel__chevron--open': isExpanded }"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span class="csv-font-medium csv-text-sm">{{ $t('settings.title') }}</span>
      </div>
      <span
        v-if="!isExpanded"
        class="csv-text-xs csv-text-muted"
      >
        {{ settingsSummary }}
      </span>
    </button>

    <!-- Expandable content -->
    <div
      v-show="isExpanded"
      class="csv-settings-panel__body"
    >
      <div class="csv-grid csv-grid-cols-2 csv-gap-4">
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">{{ $t('settings.batchSize') }}</label>
          <input
            :value="config.settings.batchSize"
            type="number"
            min="1"
            max="1000"
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
            <span class="csv-text-muted">{{ $t('settings.workersRange') }}</span>
          </label>
          <input
            :value="config.settings.workers"
            type="number"
            min="1"
            max="4"
            class="csv-settings-input"
            :class="{ 'csv-settings-input--error': workersError }"
            @input="config.setSettings({ workers: Math.max(1, Math.min(4, parseInt(($event.target as HTMLInputElement).value) || 1)) })"
          />
          <span v-if="workersError" class="csv-text-xs csv-text-red-600 csv-mt-1 csv-block">
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
            @change="config.setSettings({ encoding: ($event.target as HTMLSelectElement).value as any })"
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
            @change="config.setSettings({ delimiter: ($event.target as HTMLSelectElement).value as any })"
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
            :checked="config.settings.dryRun"
            type="checkbox"
            id="dryRun"
            @change="config.setSettings({ dryRun: ($event.target as HTMLInputElement).checked })"
          />
          <label for="dryRun" class="csv-text-sm">{{ $t('settings.dryRun') }}</label>
        </div>
        <div class="csv-flex csv-items-center csv-gap-2 csv-pt-4">
          <input
            :checked="config.settings.legacyImport"
            type="checkbox"
            id="legacyImport"
            @change="config.setSettings({ legacyImport: ($event.target as HTMLInputElement).checked })"
          />
          <label for="legacyImport" class="csv-text-sm">{{ $t('settings.legacyImport') }}</label>
        </div>
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">{{ $t('settings.language') }}</label>
          <input
            :value="config.settings.lang"
            type="text"
            class="csv-settings-input"
            placeholder="e.g. de_DE"
            @input="config.setSettings({ lang: ($event.target as HTMLInputElement).value })"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.csv-settings-panel {
  border: 1px solid #e5e7eb;
  border-radius: var(--radius, 0.375rem);
  background: #fafafa;
}
.csv-settings-panel__header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem;
  text-align: left;
  background: none;
  border: none;
  font: inherit;
  cursor: pointer;
}
.csv-settings-panel__header:hover {
  background: #f3f4f6;
}
.csv-settings-panel__chevron {
  width: 1rem;
  height: 1rem;
  color: #6b7280;
  transition: transform 0.15s;
}
.csv-settings-panel__chevron--open {
  transform: rotate(90deg);
}
.csv-settings-panel__body {
  padding: 0 0.75rem 0.75rem;
  border-top: 1px solid #e5e7eb;
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
</style>
