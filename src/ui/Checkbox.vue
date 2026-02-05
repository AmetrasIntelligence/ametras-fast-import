<script setup lang="ts">
defineProps<{
  modelValue?: boolean
  label?: string
  disabled?: boolean
}>()

defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>

<template>
  <label class="csv-checkbox-wrapper">
    <input
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      class="csv-checkbox"
      @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span v-if="label" class="csv-checkbox-label">{{ label }}</span>
    <slot />
  </label>
</template>

<style scoped>
.csv-checkbox-wrapper {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}
.csv-checkbox {
  width: 1rem;
  height: 1rem;
  border: 1px solid #d1d5db;
  border-radius: 0.25rem;
  cursor: pointer;
}
.csv-checkbox:checked {
  background-color: #2563eb;
  border-color: #2563eb;
}
.csv-checkbox:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.csv-checkbox-label {
  font-size: 0.875rem;
}
</style>
