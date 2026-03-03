<script setup lang="ts">
defineProps<{
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost'
  size?: 'default' | 'sm' | 'lg'
  disabled?: boolean
  loading?: boolean
  type?: 'button' | 'submit'
}>()
</script>

<template>
  <button
    :type="type || 'button'"
    :disabled="disabled || loading"
    :class="[
      'btn',
      size === 'sm' ? 'btn-sm' :
      size === 'lg' ? 'btn-lg' :
      '',
      variant === 'destructive' ? 'btn-danger' :
      variant === 'outline' ? 'btn-outline-secondary' :
      variant === 'secondary' ? 'btn-secondary' :
      variant === 'ghost' ? 'btn-link text-body-secondary' :
      'btn-primary'
    ]"
  >
    <span v-if="loading" class="spinner-border spinner-border-sm me-2" role="status"></span>
    <slot />
  </button>
</template>
