<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Card } from '@/ui'
import { logger } from '@/utils/logger'

const { t } = useI18n()

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

  <div v-else class="min-vh-100 d-flex align-items-center justify-content-center p-3">
    <Card class="p-4" style="max-width: 32rem;">
      <h2 class="fs-5 fw-semibold text-danger mb-3">
        {{ t('errorBoundary.title') }}
      </h2>

      <p class="text-body-secondary mb-3">
        {{ t('errorBoundary.description') }}
      </p>

      <div class="p-3 rounded mb-3 small font-monospace overflow-auto" style="max-height: 8rem; background: var(--bs-tertiary-bg);">
        {{ error.message }}
      </div>

      <div class="d-flex gap-3">
        <Button @click="reset">
          {{ t('errorBoundary.reset') }}
        </Button>
        <Button variant="outline" @click="exportDiagnostics">
          {{ t('errorBoundary.downloadDiagnostics') }}
        </Button>
      </div>
    </Card>
  </div>
</template>
