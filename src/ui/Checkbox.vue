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
  <div class="form-check">
    <input
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      class="form-check-input"
      @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <label v-if="label" class="form-check-label">{{ label }}</label>
    <slot />
  </div>
</template>
