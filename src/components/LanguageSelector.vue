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
    class="form-select form-select-sm"
    style="width: auto; font-size: 0.75rem; padding: 0.125rem 1.75rem 0.125rem 0.5rem;"
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
