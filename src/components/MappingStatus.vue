<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  status: 'valid' | 'partial' | 'none'
  compact?: boolean
}>()

const config = computed(() => {
  switch (props.status) {
    case 'valid':
      return { label: 'Ready to import', dotClass: 'bg-success', badgeClass: 'text-bg-success' }
    case 'partial':
      return { label: 'Some fields unmapped', dotClass: 'bg-warning', badgeClass: 'text-bg-warning' }
    case 'none':
      return { label: 'No model selected', dotClass: 'bg-danger', badgeClass: 'text-bg-danger' }
    default:
      return { label: '', dotClass: '', badgeClass: '' }
  }
})
</script>

<template>
  <span
    v-if="compact"
    class="d-inline-block rounded-circle"
    :class="config.dotClass"
    :title="config.label"
    style="width: 0.5rem; height: 0.5rem;"
  />
  <span
    v-else
    class="badge"
    :class="config.badgeClass"
    style="font-size: 0.75rem; font-weight: 500;"
  >
    {{ config.label }}
  </span>
</template>
