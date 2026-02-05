<script setup lang="ts">
defineProps<{
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost'
  size?: 'default' | 'sm' | 'lg'
  disabled?: boolean
  loading?: boolean
  type?: 'button' | 'submit'
}>()
</script>

<template>
  <button
    :type="type || 'button'"
    :disabled="disabled || loading"
    :class="[
      'csv-inline-flex csv-items-center csv-justify-center csv-rounded csv-font-medium csv-transition',
      'focus:outline-none focus:ring-2 focus:ring-offset-2',
      size === 'sm' ? 'csv-px-3 csv-py-1 csv-text-sm' :
      size === 'lg' ? 'csv-px-6 csv-py-3' :
      'csv-px-4 csv-py-2',
      variant === 'destructive' ? 'csv-bg-red-600 csv-text-white hover:csv-bg-red-700' :
      variant === 'outline' ? 'csv-border csv-bg-white hover:csv-bg-gray-50' :
      variant === 'secondary' ? 'csv-bg-gray-100 hover:csv-bg-gray-200' :
      variant === 'ghost' ? 'hover:csv-bg-gray-100' :
      'csv-bg-blue-600 csv-text-white hover:csv-bg-blue-700',
      (disabled || loading) ? 'csv-opacity-50 csv-cursor-not-allowed' : 'csv-cursor-pointer'
    ]"
  >
    <span v-if="loading" class="csv-mr-2 csv-animate-spin">&#x27F3;</span>
    <slot />
  </button>
</template>

<style scoped>
button {
  border: none;
  font-family: inherit;
}
.csv-text-white { color: white; }
.csv-bg-blue-600 { background-color: #2563eb; }
.csv-bg-blue-700 { background-color: #1d4ed8; }
.hover\:csv-bg-blue-700:hover { background-color: #1d4ed8; }
.csv-bg-red-600 { background-color: #dc2626; }
.csv-bg-red-700 { background-color: #b91c1c; }
.hover\:csv-bg-red-700:hover { background-color: #b91c1c; }
.csv-bg-gray-100 { background-color: #f3f4f6; }
.csv-bg-gray-200 { background-color: #e5e7eb; }
.hover\:csv-bg-gray-100:hover { background-color: #f3f4f6; }
.hover\:csv-bg-gray-200:hover { background-color: #e5e7eb; }
.hover\:csv-bg-gray-50:hover { background-color: #f9fafb; }
.csv-opacity-50 { opacity: 0.5; }
.csv-cursor-not-allowed { cursor: not-allowed; }
.csv-inline-flex { display: inline-flex; }
.csv-px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
.csv-px-4 { padding-left: 1rem; padding-right: 1rem; }
.csv-px-6 { padding-left: 1.5rem; padding-right: 1.5rem; }
.csv-py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
.csv-py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
.csv-py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
</style>
