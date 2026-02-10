<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SUPPORTED_LOCALES, setLocale, type SupportedLocale } from '@/i18n'

const { locale } = useI18n()

const currentLocale = computed({
  get: () => locale.value as SupportedLocale,
  set: (val: SupportedLocale) => setLocale(val)
})
</script>

<template>
  <select
    v-model="currentLocale"
    class="csv-lang-selector"
  >
    <option
      v-for="loc in SUPPORTED_LOCALES"
      :key="loc.code"
      :value="loc.code"
    >
      {{ loc.name }}
    </option>
  </select>
</template>

<style scoped>
.csv-lang-selector {
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
  color: #6b7280;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 0.25rem;
  cursor: pointer;
}
.csv-lang-selector:hover {
  border-color: #d1d5db;
}
.csv-lang-selector:focus {
  outline: none;
  border-color: #2563eb;
}
</style>
