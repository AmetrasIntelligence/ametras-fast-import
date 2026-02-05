<script setup lang="ts">
import { ref, computed } from 'vue'
import { useConfigStore } from '@/stores/config'

const config = useConfigStore()

// Local state only, not persisted
const isExpanded = ref(false)

const settingsSummary = computed(() => {
  const s = config.settings
  const parts = [
    `Batch: ${s.batchSize}`,
    `Retries: ${s.retryLimit}`,
    `Encoding: ${s.encoding}`,
    `Stop on error: ${s.stopOnFatalError ? 'Yes' : 'No'}`
  ]
  if (s.dryRun) parts.push('DRY RUN')
  return parts.join(' | ')
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
        <span class="csv-font-medium csv-text-sm">Import Settings</span>
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
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">Batch Size</label>
          <input
            :value="config.settings.batchSize"
            type="number"
            min="1"
            max="1000"
            class="csv-settings-input"
            @input="config.setSettings({ batchSize: parseInt(($event.target as HTMLInputElement).value) || 100 })"
          />
        </div>
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">Retry Limit</label>
          <input
            :value="config.settings.retryLimit"
            type="number"
            min="0"
            max="10"
            class="csv-settings-input"
            @input="config.setSettings({ retryLimit: parseInt(($event.target as HTMLInputElement).value) || 0 })"
          />
        </div>
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">Retry Delay (ms)</label>
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
          <label for="stopOnError" class="csv-text-sm">Stop on fatal error</label>
        </div>
      </div>

      <div class="csv-grid csv-grid-cols-2 csv-gap-4 csv-mt-4">
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">Encoding</label>
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
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">Delimiter</label>
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
          <label for="skipHeader" class="csv-text-sm">Skip header row</label>
        </div>
        <div class="csv-flex csv-items-center csv-gap-2 csv-pt-4">
          <input
            :checked="config.settings.dryRun"
            type="checkbox"
            id="dryRun"
            @change="config.setSettings({ dryRun: ($event.target as HTMLInputElement).checked })"
          />
          <label for="dryRun" class="csv-text-sm">Dry run (validate only)</label>
        </div>
        <div>
          <label class="csv-text-xs csv-text-muted csv-block csv-mb-1">Language</label>
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
</style>
