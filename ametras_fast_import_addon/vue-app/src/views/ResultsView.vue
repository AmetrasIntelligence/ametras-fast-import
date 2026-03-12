<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRunStore } from '@/stores/run'
import { useSessionStore } from '@/stores/session'
import { useFilesStore } from '@/stores/files'
import { ImportEngine } from '@/importer/engine'
import { ImportState } from '@/importer/stateMachine'
import { showAlert } from '@/composables/useDialog'
import { downloadCSV, downloadJSON } from '@/utils/formatters'
import { logger } from '@/utils/logger'
import { Button, Card, Table } from '@/ui'

const { t } = useI18n()
const router = useRouter()
const run = useRunStore()
const session = useSessionStore()
const isRetrying = ref(false)
const loading = ref(false)
const loadError = ref<string | null>(null)

onMounted(async () => {
  // If we have a logId but no completed state, we navigated here from history
  // and need to fetch the log data from the server
  if (run.logId && !run.isCompleted) {
    loading.value = true
    loadError.value = null
    try {
      const success = await run.loadFromServerLog(run.logId)
      if (!success) {
        loadError.value = t('results.loadFailed')
      }
    } catch (e) {
      loadError.value = t('results.loadError', { error: e instanceof Error ? e.message : String(e) })
      logger.import.error('Failed to load historical log', { error: loadError.value })
    } finally {
      loading.value = false
    }
  }
})

const summary = computed(() => {
  const files = Object.values(run.progress.files)
  return {
    totalRows: files.reduce((sum, f) => sum + f.totalRows, 0),
    successRows: files.reduce((sum, f) => sum + f.successCount, 0),
    failedRows: files.reduce((sum, f) => sum + f.failedCount, 0),
    duration: calculateDuration()
  }
})

function calculateDuration(): string {
  if (!run.runStartTime) return '--'
  const files = Object.values(run.progress.files)
  const lastEndTime = Math.max(...files.map(f => f.endTime || 0))
  if (lastEndTime === 0) return '--'
  const duration = lastEndTime - run.runStartTime
  return `${Math.round(duration / 1000)}s`
}

function exportErrorsCSV() {
  const headers = ['filename', 'row_number', 'error', 'timestamp']
  const lines = [headers.join(',')]

  for (const error of run.errors) {
    lines.push([
      error.filename,
      error.rowNumber,
      `"${error.error.replace(/"/g, '""')}"`,
      new Date(error.timestamp).toISOString()
    ].join(','))
  }

  downloadCSV(lines.join('\n'), 'import-errors.csv')
}

function exportFullReport() {
  const report = {
    summary: summary.value,
    files: Object.values(run.progress.files),
    errors: run.errors
  }

  downloadJSON(report, 'import-report.json')
}

function retryFailedRows() {
  if (isRetrying.value) return

  // Check if files are still available before retrying
  const filesStore = useFilesStore()
  const hasFiles = filesStore.files.length > 0
  if (!hasFiles) {
    showAlert(t('results.retryNoFiles'))
    return
  }

  isRetrying.value = true
  run.isHistoricalLog = false

  // Create engine and mark run as active BEFORE navigating.
  // This prevents RunView.onMounted from creating a second engine
  // (it early-returns when run.isActive is true).
  const engine = new ImportEngine()
  run.setEngine(engine)
  run.setState(ImportState.VALIDATING)

  // Start retry in background (don't await - let RunView display progress)
  engine.retryFailedRows().catch(e => {
    logger.import.error('Retry failed', { error: e instanceof Error ? e.message : String(e) })
  })

  // Navigate to run view immediately to show progress
  router.push('/run')
}

function closeDialog() {
  run.reset()
  const callback = session.closeDialogCallback
  if (callback) {
    callback()
  } else {
    router.push('/import')
  }
}

function startNew() {
  run.reset()
  router.push('/import')
}
</script>

<template>
  <div class="p-4 d-flex flex-column gap-4">
    <!-- Loading state -->
    <div v-if="loading" class="d-flex justify-content-center align-items-center py-5">
      <div class="spinner-border text-primary" role="status">
        <span class="visually-hidden">{{ $t('results.loading') }}</span>
      </div>
      <span class="ms-3">{{ $t('results.loading') }}</span>
    </div>

    <!-- Load error -->
    <div v-else-if="loadError" class="alert alert-danger">
      {{ loadError }}
      <div class="mt-3">
        <Button @click="startNew">{{ $t('results.close') }}</Button>
      </div>
    </div>

    <template v-else>
      <!-- Dry Run Banner -->
      <div v-if="run.isDryRun" class="alert alert-warning mb-0">
        {{ $t('results.dryRunBanner', { count: summary.totalRows.toLocaleString() }) }}
      </div>

      <!-- Summary Card -->
      <Card class="p-4">
        <h2 class="fs-5 fw-semibold mb-3">
          {{ run.isDryRun ? $t('results.dryRunComplete') : $t('results.importComplete') }}
        </h2>

        <div class="row row-cols-4 g-3">
          <div>
            <div class="fs-2 fw-bold">
              {{ summary.totalRows.toLocaleString() }}
            </div>
            <small class="text-body-secondary">{{ $t('results.totalRows') }}</small>
          </div>
          <div>
            <div class="fs-2 fw-bold text-success">
              {{ summary.successRows.toLocaleString() }}
            </div>
            <small class="text-body-secondary">{{ $t('results.successful') }}</small>
          </div>
          <div>
            <div class="fs-2 fw-bold text-danger">
              {{ summary.failedRows.toLocaleString() }}
            </div>
            <small class="text-body-secondary">{{ $t('results.failed') }}</small>
          </div>
          <div>
            <div class="fs-2 fw-bold">
              {{ summary.duration }}
            </div>
            <small class="text-body-secondary">{{ $t('results.duration') }}</small>
          </div>
        </div>
      </Card>

      <!-- Export Actions -->
      <Card class="p-3">
        <h3 class="fw-semibold mb-3">{{ $t('results.export') }}</h3>

        <div class="d-flex gap-3">
          <Button
            v-if="run.errors.length > 0"
            variant="outline"
            @click="exportErrorsCSV"
          >
            {{ $t('results.downloadErrors') }}
          </Button>

          <Button
            variant="outline"
            @click="exportFullReport"
          >
            {{ $t('results.downloadReport') }}
          </Button>
        </div>
      </Card>

      <!-- Error Details -->
      <Card v-if="run.errors.length > 0" class="p-3">
        <h3 class="fw-semibold mb-3">
          {{ $t('results.errors') }} ({{ run.errors.length }})
        </h3>

        <div class="overflow-auto" style="max-height: 24rem;">
          <Table>
            <thead>
              <tr>
                <th class="text-start">{{ $t('results.file') }}</th>
                <th class="text-end">{{ $t('results.row') }}</th>
                <th class="text-start">{{ $t('results.error') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(error, idx) in run.errors" :key="idx">
                <td>{{ error.filename }}</td>
                <td class="text-end">{{ error.rowNumber }}</td>
                <td class="text-danger">{{ error.error }}</td>
              </tr>
            </tbody>
          </Table>
        </div>
      </Card>

      <div class="d-flex justify-content-end gap-3">
        <!-- Addon dialog mode -->
        <template v-if="session.inDialog">
          <Button
            v-if="run.hasRetryableErrors && !run.isDryRun && !run.isHistoricalLog"
            variant="outline"
            :disabled="isRetrying || run.isActive"
            @click="retryFailedRows"
          >
            {{ isRetrying ? $t('results.retrying') : $t('results.retryFailed') }}
          </Button>
          <Button @click="closeDialog">
            {{ $t('common.ok') }}
          </Button>
        </template>

        <!-- Standalone / non-dialog mode -->
        <template v-else>
          <Button
            v-if="run.hasRetryableErrors && !run.isDryRun && !run.isHistoricalLog"
            variant="outline"
            :disabled="isRetrying || run.isActive"
            @click="retryFailedRows"
          >
            {{ isRetrying ? $t('results.retrying') : $t('results.retryFailed') }}
          </Button>
          <Button @click="startNew">
            {{ run.isHistoricalLog ? $t('results.close') : $t('results.startNew') }}
          </Button>
        </template>
      </div>
    </template>
  </div>
</template>
