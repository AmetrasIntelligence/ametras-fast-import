<script setup lang="ts">
import { computed } from 'vue'
import type { OdooModel } from '@/api/odooClient'

const props = defineProps<{
  suggestion: { model: OdooModel; score: number } | null
  currentModel: string | null
}>()

const emit = defineEmits<{
  accept: [model: string]
  chooseAnother: []
}>()

const confidencePercent = computed(() =>
  props.suggestion ? Math.min(props.suggestion.score, 100) : 0
)

const confidenceLabel = computed(() => {
  const p = confidencePercent.value
  if (p >= 80) return 'High confidence'
  if (p >= 50) return 'Medium confidence'
  return 'Low confidence'
})
</script>

<template>
  <div
    v-if="suggestion && !currentModel"
    class="csv-suggestion"
  >
    <div class="csv-text-sm csv-text-muted csv-mb-2">
      Suggested mapping:
    </div>
    <div class="csv-flex csv-items-center csv-justify-between">
      <div>
        <span class="csv-font-medium">{{ suggestion.model.name }}</span>
        <span class="csv-text-xs csv-text-muted csv-ml-1">
          ({{ confidencePercent }}% &mdash; {{ confidenceLabel }})
        </span>
      </div>
      <div class="csv-flex csv-gap-2">
        <button
          type="button"
          class="csv-suggestion__accept"
          @click="emit('accept', suggestion.model.model)"
        >
          &#10003; Accept
        </button>
        <button
          type="button"
          class="csv-suggestion__choose"
          @click="emit('chooseAnother')"
        >
          Choose another
        </button>
      </div>
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
.csv-suggestion__choose {
  padding: 0.25rem 0.75rem;
  font-size: 0.875rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  background: white;
  cursor: pointer;
  font-family: inherit;
}
.csv-suggestion__choose:hover {
  background: #f3f4f6;
}
</style>
