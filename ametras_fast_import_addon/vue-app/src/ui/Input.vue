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
    class="form-control form-control-sm"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>
