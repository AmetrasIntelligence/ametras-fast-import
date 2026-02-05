<script setup lang="ts">
</script>

<template>
  <div class="csv-table-wrapper">
    <table class="csv-table">
      <slot />
    </table>
  </div>
</template>

<style scoped>
.csv-table-wrapper {
  width: 100%;
  overflow-x: auto;
}
.csv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.csv-table :deep(th),
.csv-table :deep(td) {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #e5e7eb;
}
.csv-table :deep(th) {
  font-weight: 600;
  text-align: left;
  background: #f9fafb;
}
.csv-table :deep(tbody tr:hover) {
  background: #f9fafb;
}
</style>
