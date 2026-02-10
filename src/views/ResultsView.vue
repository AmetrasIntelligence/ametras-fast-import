<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useRunStore } from '@/stores/run'
import { useFilesStore } from '@/stores/files'
import { ImportEngine } from '@/importer/engine'
import { Button, Card, Table } from '@/ui'

const router = useRouter()
const run = useRunStore()
const isRetrying = ref(false)

const summary = computed(() => {
  const files = Array.from(run.progress.files.values())
  return {
    totalRows: files.reduce((sum, f) => sum + f.totalRows, 0),
    successRows: files.reduce((sum, f) => sum + f.successCount, 0),
    failedRows: files.reduce((sum, f) => sum + f.failedCount, 0),
    duration: calculateDuration()
  }
})

function calculateDuration(): string {
  if (!run.runStartTime) return '--'
  const files = Array.from(run.progress.files.values())
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
    files: Array.from(run.progress.files.values()),
    errors: run.errors
  }

  downloadJSON(report, 'import-report.json')
}

function downloadCSV(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function downloadJSON(data: unknown, filename: string) {
  const content = JSON.stringify(data, null, 2)
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function retryFailedRows() {
  if (isRetrying.value) return

  // Check if files are still available before retrying
  const filesStore = useFilesStore()
  const hasFiles = filesStore.files.length > 0
  if (!hasFiles) {
    alert('Files are no longer available for retry. Please start a new import.')
    return
  }

  isRetrying.value = true
  try {
    const engine = new ImportEngine()
    run.setEngine(engine)
    await engine.retryFailedRows()
  } catch (e) {
    console.error('Retry failed:', e)
    alert(`Retry failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
  } finally {
    isRetrying.value = false
    run.setEngine(null)
  }
}

function startNew() {
  run.reset()
  router.push('/files')
}
</script>

<template>
  <div class="csv-p-6 csv-space-y-6">
    <!-- Dry Run Banner -->
    <div v-if="run.isDryRun" class="csv-dry-run-banner">
      {{ $t('results.dryRunBanner', { count: summary.totalRows.toLocaleString() }) }}
    </div>

    <!-- Summary Card -->
    <Card class="csv-p-6">
      <h2 class="csv-text-xl csv-font-semibold csv-mb-4">
        {{ run.isDryRun ? $t('results.dryRunComplete') : $t('results.importComplete') }}
      </h2>

      <div class="csv-grid csv-grid-cols-4 csv-gap-4">
        <div>
          <div class="csv-text-3xl csv-font-bold">
            {{ summary.totalRows.toLocaleString() }}
          </div>
          <div class="csv-text-sm csv-text-muted">{{ $t('results.totalRows') }}</div>
        </div>
        <div>
          <div class="csv-text-3xl csv-font-bold csv-text-green-600">
            {{ summary.successRows.toLocaleString() }}
          </div>
          <div class="csv-text-sm csv-text-muted">{{ $t('results.successful') }}</div>
        </div>
        <div>
          <div class="csv-text-3xl csv-font-bold csv-text-red-600">
            {{ summary.failedRows.toLocaleString() }}
          </div>
          <div class="csv-text-sm csv-text-muted">{{ $t('results.failed') }}</div>
        </div>
        <div>
          <div class="csv-text-3xl csv-font-bold">
            {{ summary.duration }}
          </div>
          <div class="csv-text-sm csv-text-muted">{{ $t('results.duration') }}</div>
        </div>
      </div>
    </Card>

    <!-- Export Actions -->
    <Card class="csv-p-4">
      <h3 class="csv-font-semibold csv-mb-4">{{ $t('results.export') }}</h3>

      <div class="csv-flex csv-gap-4">
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
    <Card v-if="run.errors.length > 0" class="csv-p-4">
      <h3 class="csv-font-semibold csv-mb-4">
        {{ $t('results.errors') }} ({{ run.errors.length }})
      </h3>

      <div class="csv-max-h-96 csv-overflow-y-auto">
        <Table>
          <thead>
            <tr>
              <th class="csv-text-left">{{ $t('results.file') }}</th>
              <th class="csv-text-right">{{ $t('results.row') }}</th>
              <th class="csv-text-left">{{ $t('results.error') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(error, idx) in run.errors" :key="idx">
              <td>{{ error.filename }}</td>
              <td class="csv-text-right">{{ error.rowNumber }}</td>
              <td class="csv-text-red-600">{{ error.error }}</td>
            </tr>
          </tbody>
        </Table>
      </div>
    </Card>

    <div class="csv-flex csv-justify-end csv-gap-4">
      <Button
        v-if="run.hasRetryableErrors && !run.isDryRun"
        variant="outline"
        :disabled="isRetrying || run.isActive"
        @click="retryFailedRows"
      >
        {{ isRetrying ? $t('results.retrying') : $t('results.retryFailed') }}
      </Button>
      <Button @click="startNew">
        {{ $t('results.startNew') }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.csv-dry-run-banner {
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #fbbf24;
  border-radius: var(--radius, 0.375rem);
}
</style>
