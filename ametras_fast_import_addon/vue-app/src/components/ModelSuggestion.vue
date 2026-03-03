<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { OdooModel } from '@/api/odooClient'
import { Button } from '@/ui'

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
    <div class="small text-body-secondary mb-2">
      {{ $t('modelSuggestion.title') }}
    </div>
    <div class="d-flex align-items-center justify-content-between">
      <div>
        <span class="fw-medium">{{ suggestion.model.name }}</span>
        <small class="text-body-secondary ms-1">
          ({{ suggestion.model.model }})
        </small>
        <small class="text-body-secondary ms-2">
          {{ confidencePercent }}% &mdash; {{ confidenceLabel }}
        </small>
      </div>
      <Button
        size="sm"
        @click="emit('accept', suggestion.model.model)"
      >
        &#10003; {{ $t('modelSuggestion.accept') }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.csv-suggestion {
  padding: 0.75rem;
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  background: var(--bs-primary-bg-subtle);
}
</style>
