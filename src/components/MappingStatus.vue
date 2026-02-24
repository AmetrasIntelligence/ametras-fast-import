<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  status: 'valid' | 'partial' | 'none'
  compact?: boolean
}>()

const config = computed(() => {
  switch (props.status) {
    case 'valid':
      return { label: 'Ready to import', dotClass: 'csv-status--valid', badgeClass: 'csv-status-badge--valid' }
    case 'partial':
      return { label: 'Some fields unmapped', dotClass: 'csv-status--partial', badgeClass: 'csv-status-badge--partial' }
    case 'none':
      return { label: 'No model selected', dotClass: 'csv-status--none', badgeClass: 'csv-status-badge--none' }
    default:
      return { label: '', dotClass: '', badgeClass: '' }
  }
})
</script>

<template>
  <div
    v-if="compact"
    class="csv-status-dot"
    :class="config.dotClass"
    :title="config.label"
  />
  <div
    v-else
    class="csv-status-badge"
    :class="config.badgeClass"
  >
    {{ config.label }}
  </div>
</template>

<style scoped>
.csv-status-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 9999px;
}
.csv-status--valid { background-color: #22c55e; }
.csv-status--partial { background-color: #f97316; }
.csv-status--none { background-color: #ef4444; }

.csv-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.125rem 0.5rem;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.75rem;
}
.csv-status-badge--valid {
  color: #16a34a;
  background-color: #f0fdf4;
}
.csv-status-badge--partial {
  color: #ea580c;
  background-color: #fff7ed;
}
.csv-status-badge--none {
  color: #dc2626;
  background-color: #fef2f2;
}
</style>
