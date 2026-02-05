<script setup lang="ts">
import { computed } from 'vue'
import type { OdooField } from '@/api/odooClient'

const props = defineProps<{
  header: string
  suggestion: { field: OdooField; score: number } | null
  currentField: string | null
}>()

const emit = defineEmits<{
  accept: [fieldName: string]
  chooseAnother: []
  skip: []
}>()

const confidencePercent = computed(() =>
  props.suggestion ? Math.min(props.suggestion.score, 100) : 0
)
</script>

<template>
  <div
    v-if="suggestion && !currentField"
    class="csv-field-suggestion"
  >
    <div class="csv-field-suggestion__text">
      <span class="csv-font-mono csv-text-muted">{{ header }}</span>
      <span class="csv-field-suggestion__arrow">&rarr;</span>
      <span class="csv-font-medium">{{ suggestion.field.string }}</span>
      <span class="csv-text-xs csv-text-muted csv-ml-1">
        ({{ confidencePercent }}%)
      </span>
    </div>
    <div class="csv-flex csv-gap-1">
      <button
        type="button"
        class="csv-field-suggestion__btn csv-field-suggestion__btn--accept"
        title="Accept"
        @click="emit('accept', suggestion.field.name)"
      >
        &#10003;
      </button>
      <button
        type="button"
        class="csv-field-suggestion__btn"
        title="Choose another"
        @click="emit('chooseAnother')"
      >
        &#9662;
      </button>
      <button
        type="button"
        class="csv-field-suggestion__btn csv-field-suggestion__btn--skip"
        title="Skip"
        @click="emit('skip')"
      >
        &#10005;
      </button>
    </div>
  </div>
</template>

<style scoped>
.csv-field-suggestion {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.375rem 0.75rem;
  background: #eff6ff;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.875rem;
}
.csv-field-suggestion__text {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.csv-field-suggestion__arrow {
  margin: 0 0.375rem;
  color: #6b7280;
}
.csv-field-suggestion__btn {
  padding: 0.25rem;
  border-radius: var(--radius, 0.375rem);
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.75rem;
  line-height: 1;
}
.csv-field-suggestion__btn:hover {
  background: #e5e7eb;
}
.csv-field-suggestion__btn--accept:hover {
  background: #dcfce7;
  color: #16a34a;
}
.csv-field-suggestion__btn--skip:hover {
  background: #fef2f2;
  color: #dc2626;
}
</style>
