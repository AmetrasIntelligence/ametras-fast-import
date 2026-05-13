<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  value: number
  max?: number
  showLabel?: boolean
  size?: 'sm' | 'md' | 'lg'
  ariaLabel?: string
}>()

const percentage = computed(() => {
  const max = props.max ?? 100
  return Math.min(100, Math.max(0, Math.round((props.value / max) * 100)))
})

const barHeight = computed(() => {
  switch (props.size) {
    case 'sm': return '0.25rem'
    case 'lg': return '1rem'
    default: return '0.5rem'
  }
})
</script>

<template>
  <div class="w-100">
    <div class="progress" role="progressbar" :aria-valuenow="percentage" aria-valuemin="0" aria-valuemax="100" :aria-label="ariaLabel" :style="{ height: barHeight }">
      <div
        class="progress-bar"
        :style="{ width: `${percentage}%` }"
      />
    </div>
    <small v-if="showLabel" class="d-block mt-1 text-body-secondary">
      {{ percentage }}%
    </small>
  </div>
</template>
