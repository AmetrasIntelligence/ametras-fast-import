<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { OdooModel } from '@/api/odooClient'

const { t } = useI18n()

const props = defineProps<{
  suggestion: { model: OdooModel; score: number } | null
  currentModel: string | null
}>()

const emit = defineEmits<{
  accept: [model: string]
}>()

const confidencePercent = computed(() =>
  props.suggestion ? Math.min(props.suggestion.score, 100) : 0
)

const confidenceLabel = computed(() => {
  const p = confidencePercent.value
  if (p >= 80) return t('modelSuggestion.highConfidence')
  if (p >= 50) return t('modelSuggestion.mediumConfidence')
  return t('modelSuggestion.lowConfidence')
})
</script>

<template>
  <div
    v-if="suggestion && !currentModel"
    class="csv-suggestion"
  >
    <div class="csv-text-sm csv-text-muted csv-mb-2">
      {{ $t('modelSuggestion.title') }}
    </div>
    <div class="csv-flex csv-items-center csv-justify-between">
      <div>
        <span class="csv-font-medium">{{ suggestion.model.name }}</span>
        <span class="csv-text-xs csv-text-muted csv-ml-1">
          ({{ suggestion.model.model }})
        </span>
        <span class="csv-text-xs csv-text-muted csv-ml-2">
          {{ confidencePercent }}% &mdash; {{ confidenceLabel }}
        </span>
      </div>
      <button
        type="button"
        class="csv-suggestion__accept"
        @click="emit('accept', suggestion.model.model)"
      >
        &#10003; {{ $t('modelSuggestion.accept') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.csv-suggestion {
  padding: 0.75rem;
  border: 1px solid #e5e7eb;
  border-radius: var(--radius, 0.375rem);
  background: #eff6ff;
}
.csv-suggestion__accept {
  padding: 0.25rem 0.75rem;
  font-size: 0.875rem;
  color: white;
  background: #2563eb;
  border: none;
  border-radius: var(--radius, 0.375rem);
  cursor: pointer;
  font-family: inherit;
}
.csv-suggestion__accept:hover {
  background: #1d4ed8;
}
</style>
