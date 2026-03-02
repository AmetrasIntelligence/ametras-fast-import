<script setup lang="ts">
defineProps<{
  label?: string
}>()
</script>

<template>
  <div class="d-flex align-items-center gap-2">
    <hr class="flex-grow-1 m-0" />
    <small v-if="label" class="text-body-tertiary text-nowrap text-lowercase">{{ label }}</small>
    <hr v-if="label" class="flex-grow-1 m-0" />
  </div>
</template>
