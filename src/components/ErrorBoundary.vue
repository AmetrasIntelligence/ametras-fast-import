<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue'
import { Button, Card } from '@/ui'
import { logger } from '@/utils/logger'

const error = ref<Error | null>(null)
const errorInfo = ref<string | null>(null)

onErrorCaptured((err, _instance, info) => {
  error.value = err
  errorInfo.value = info

  logger.error('ErrorBoundary', 'Uncaught error in component', {
    error: err.message,
    stack: err.stack,
    info
  })

  return false
})

function reset() {
  error.value = null
  errorInfo.value = null
}

function exportDiagnostics() {
  const diagnostics = {
    error: {
      message: error.value?.message,
      stack: error.value?.stack,
      info: errorInfo.value
    },
    logs: logger.getEntries(),
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent
  }

  const blob = new Blob([JSON.stringify(diagnostics, null, 2)], {
    type: 'application/json'
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `csv-import-diagnostics-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <slot v-if="!error" />

  <div v-else class="csv-min-h-screen csv-flex csv-items-center csv-justify-center csv-p-4">
    <Card class="csv-max-w-lg csv-p-6">
      <h2 class="csv-text-xl csv-font-semibold csv-text-red-600 csv-mb-4">
        {{ $t('errorBoundary.title') }}
      </h2>

      <p class="csv-text-muted csv-mb-4">
        {{ $t('errorBoundary.description') }}
      </p>

      <div class="csv-bg-gray-100 csv-p-3 csv-rounded csv-mb-4 csv-text-sm csv-font-mono csv-overflow-auto csv-max-h-32">
        {{ error.message }}
      </div>

      <div class="csv-flex csv-gap-4">
        <Button @click="reset">
          {{ $t('errorBoundary.reset') }}
        </Button>
        <Button variant="outline" @click="exportDiagnostics">
          {{ $t('errorBoundary.downloadDiagnostics') }}
        </Button>
      </div>
    </Card>
  </div>
</template>
