<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useRunStore } from '@/stores/run'
import { Button, Card, Table } from '@/ui'

const router = useRouter()
const run = useRunStore()

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

function startNew() {
  run.reset()
  router.push('/files')
}
</script>

<template>
  <div class="csv-p-6 csv-space-y-6">
    <!-- Dry Run Banner -->
    <div v-if="run.isDryRun" class="csv-dry-run-banner">
      Dry Run Complete &mdash; {{ summary.totalRows.toLocaleString() }} rows validated, no data written.
    </div>

    <!-- Summary Card -->
    <Card class="csv-p-6">
      <h2 class="csv-text-xl csv-font-semibold csv-mb-4">
        {{ run.isDryRun ? 'Dry Run Complete' : 'Import Complete' }}
      </h2>

      <div class="csv-grid csv-grid-cols-4 csv-gap-4">
        <div>
          <div class="csv-text-3xl csv-font-bold">
            {{ summary.totalRows.toLocaleString() }}
          </div>
          <div class="csv-text-sm csv-text-muted">Total Rows</div>
        </div>
        <div>
          <div class="csv-text-3xl csv-font-bold csv-text-green-600">
            {{ summary.successRows.toLocaleString() }}
          </div>
          <div class="csv-text-sm csv-text-muted">Successful</div>
        </div>
        <div>
          <div class="csv-text-3xl csv-font-bold csv-text-red-600">
            {{ summary.failedRows.toLocaleString() }}
          </div>
          <div class="csv-text-sm csv-text-muted">Failed</div>
        </div>
        <div>
          <div class="csv-text-3xl csv-font-bold">
            {{ summary.duration }}
          </div>
          <div class="csv-text-sm csv-text-muted">Duration</div>
        </div>
      </div>
    </Card>

    <!-- Export Actions -->
    <Card class="csv-p-4">
      <h3 class="csv-font-semibold csv-mb-4">Export</h3>

      <div class="csv-flex csv-gap-4">
        <Button
          v-if="run.errors.length > 0"
          variant="outline"
          @click="exportErrorsCSV"
        >
          Download Error Log (CSV)
        </Button>

        <Button
          variant="outline"
          @click="exportFullReport"
        >
          Download Full Report (JSON)
        </Button>
      </div>
    </Card>

    <!-- Error Details -->
    <Card v-if="run.errors.length > 0" class="csv-p-4">
      <h3 class="csv-font-semibold csv-mb-4">
        Errors ({{ run.errors.length }})
      </h3>

      <div class="csv-max-h-96 csv-overflow-y-auto">
        <Table>
          <thead>
            <tr>
              <th class="csv-text-left">File</th>
              <th class="csv-text-right">Row</th>
              <th class="csv-text-left">Error</th>
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

    <div class="csv-flex csv-justify-end">
      <Button @click="startNew">
        Start New Import
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
