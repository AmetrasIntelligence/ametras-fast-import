<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  value: number
  max?: number
  showLabel?: boolean
  size?: 'sm' | 'md' | 'lg'
}>()

const percentage = computed(() => {
  const max = props.max ?? 100
  return Math.min(100, Math.max(0, Math.round((props.value / max) * 100)))
})
</script>

<template>
  <div class="csv-progress-wrapper">
    <div
      :class="[
        'csv-progress-track',
        props.size === 'sm' ? 'csv-h-1' : props.size === 'lg' ? 'csv-h-4' : 'csv-h-2'
      ]"
    >
      <div
        class="csv-progress-bar"
        :style="{ width: `${percentage}%` }"
      />
    </div>
    <span v-if="showLabel" class="csv-progress-label">
      {{ percentage }}%
    </span>
  </div>
</template>

<style scoped>
.csv-progress-wrapper {
  width: 100%;
}
.csv-progress-track {
  width: 100%;
  background: #e5e7eb;
  border-radius: 9999px;
  overflow: hidden;
}
.csv-h-1 { height: 0.25rem; }
.csv-h-2 { height: 0.5rem; }
.csv-h-4 { height: 1rem; }
.csv-progress-bar {
  height: 100%;
  background: #2563eb;
  border-radius: 9999px;
  transition: width 0.3s ease;
}
.csv-progress-label {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.875rem;
  color: #6b7280;
}
</style>
