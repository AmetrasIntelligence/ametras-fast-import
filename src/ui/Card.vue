<script setup lang="ts">
</script>

<template>
  <div class="csv-card">
    <slot />
  </div>
</template>

<style scoped>
.csv-card {
  background: white;
  border-radius: 0.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  border: 1px solid #e5e7eb;
}
</style>
