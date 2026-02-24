<script setup lang="ts">
defineProps<{
  label?: string
}>()
</script>

<template>
  <div class="csv-divider" :class="{ 'csv-divider--labeled': label }">
    <div class="csv-divider__line" />
    <span v-if="label" class="csv-divider__label">{{ label }}</span>
    <div v-if="label" class="csv-divider__line" />
  </div>
</template>

<style scoped>
.csv-divider {
  display: flex;
  align-items: center;
}

.csv-divider__line {
  flex: 1;
  height: 1px;
  background: #e5e7eb;
}

.csv-divider--labeled .csv-divider__label {
  padding: 0 0.75rem;
  font-size: 0.75rem;
  color: #9ca3af;
  white-space: nowrap;
  text-transform: lowercase;
}
</style>
