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
      <span class="font-monospace text-body-secondary">{{ header }}</span>
      <span class="csv-field-suggestion__arrow">&rarr;</span>
      <span class="fw-medium">{{ suggestion.field.string }}</span>
      <small class="text-body-secondary ms-1">
        ({{ confidencePercent }}%)
      </small>
    </div>
    <div class="d-flex gap-1">
      <button
        type="button"
        class="csv-field-suggestion__btn csv-field-suggestion__btn--accept"
        :title="$t('modelSuggestion.accept')"
        @click="emit('accept', suggestion.field.name)"
      >
        &#10003;
      </button>
      <button
        type="button"
        class="csv-field-suggestion__btn"
        :title="$t('modelSuggestion.chooseAnother')"
        @click="emit('chooseAnother')"
      >
        &#9662;
      </button>
      <button
        type="button"
        class="csv-field-suggestion__btn csv-field-suggestion__btn--skip"
        :title="$t('common.skip')"
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
  background: var(--bs-primary-bg-subtle);
  border-radius: var(--bs-border-radius);
  font-size: 0.875rem;
}
.csv-field-suggestion__text {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.csv-field-suggestion__arrow {
  margin: 0 0.375rem;
  color: var(--bs-secondary-color);
}
.csv-field-suggestion__btn {
  padding: 0.25rem;
  border-radius: var(--bs-border-radius);
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.75rem;
  line-height: 1;
}
.csv-field-suggestion__btn:hover {
  background: var(--bs-tertiary-bg);
}
.csv-field-suggestion__btn:focus-visible {
  outline: 2px solid var(--bs-primary);
  outline-offset: -1px;
}
.csv-field-suggestion__btn--accept:hover {
  background: var(--bs-success-bg-subtle);
  color: var(--bs-success);
}
.csv-field-suggestion__btn--skip:hover {
  background: var(--bs-danger-bg-subtle);
  color: var(--bs-danger);
}
</style>
