<script setup lang="ts">
defineProps<{
  modelValue?: string
  type?: string
  placeholder?: string
  required?: boolean
  disabled?: boolean
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <input
    :value="modelValue"
    :type="type || 'text'"
    :placeholder="placeholder"
    :required="required"
    :disabled="disabled"
    class="csv-input"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.csv-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  font-family: inherit;
  background: white;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.csv-input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}
.csv-input:disabled {
  background: #f3f4f6;
  cursor: not-allowed;
}
</style>
