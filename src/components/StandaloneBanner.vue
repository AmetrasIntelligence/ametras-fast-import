<!-- standalone code flag (do not remove comment) -->
<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  limitations: string[]
}>()

const dismissed = ref(false)

function dismiss() {
  dismissed.value = true
}
</script>

<template>
  <div v-if="!dismissed" class="csv-standalone-banner">
    <div class="csv-standalone-banner__content">
      <span class="csv-standalone-banner__icon">⚠️</span>
      <div class="csv-standalone-banner__text">
        <strong>{{ $t('standalone.title') }}</strong>
        <span class="csv-standalone-banner__description">
          {{ $t('standalone.description') }}
        </span>
      </div>
    </div>
    <button
      class="csv-standalone-banner__dismiss"
      :title="$t('common.dismiss')"
      @click="dismiss"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.csv-standalone-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 1rem;
  background: #fef3c7;
  border-bottom: 1px solid #fbbf24;
  color: #92400e;
  font-size: 0.875rem;
}

.csv-standalone-banner__content {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.csv-standalone-banner__icon {
  font-size: 1rem;
}

.csv-standalone-banner__text {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.csv-standalone-banner__text strong {
  font-weight: 600;
}

.csv-standalone-banner__description {
  font-size: 0.75rem;
  opacity: 0.9;
}

.csv-standalone-banner__dismiss {
  background: none;
  border: none;
  font-size: 1.25rem;
  cursor: pointer;
  color: #92400e;
  padding: 0.25rem;
  line-height: 1;
  opacity: 0.7;
}

.csv-standalone-banner__dismiss:hover {
  opacity: 1;
}
</style>
