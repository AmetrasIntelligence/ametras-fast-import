<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRunStore } from '@/stores/run'
import { useSessionStore } from '@/stores/session'
import { useFilesStore } from '@/stores/files'
import { useConfigStore } from '@/stores/config'
import { ImportState } from '@/types/importState'
import { showAlert } from '@/utils/dialog'
import { downloadCSV } from '@/utils/formatters'
import { downloadBlob } from '@/utils/profileUtils'
import { buildFailedRowsCsv } from '@/utils/errorExport'
import { startImportValidation, getImportValidation } from '@/api/odooClient'
import { logger } from '@/utils/logger'
import { Button, Card, Table } from '@/ui'
import Papa from 'papaparse'
import JSZip from 'jszip'

const { t } = useI18n()
const router = useRouter()
const run = useRunStore()
const session = useSessionStore()
const filesStore = useFilesStore()
const config = useConfigStore()
const isRetrying = ref(false)
const isExporting = ref(false)
const loading = ref(false)
const loadError = ref<string | null>(null)
const isValidating = ref(false)
let validationPollTimer: ReturnType<typeof setTimeout> | null = null

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
  // Auto-validate (per-profile) may still be running server-side — resume polling.
  if (session.isEmbedded && run.logId && run.validationState === 'running') {
    isValidating.value = true
    pollValidation()
  }
})

onBeforeUnmount(() => {
  if (validationPollTimer) clearTimeout(validationPollTimer)
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

/** Errors grouped by filename in insertion order. */
const errorsByFilename = computed(() => {
  const map = new Map<string, typeof run.errors>()
  for (const err of run.errors) {
    const key = err.filename || '(unknown)'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(err)
  }
  return map
})

const hasTruncatedErrors = computed(
  () => run.totalErrorsSeen > run.errors.length
)

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

  for (const error of run.downloadErrors) {
    lines.push([
      error.filename,
      error.rowNumber,
      `"${error.error.replace(/"/g, '""')}"`,
      new Date(error.timestamp).toISOString()
    ].join(','))
  }

  downloadCSV(lines.join('\n'), 'import-errors.csv')
}

/**
 * Read a source CSV file and return its parsed rows indexed by row number.
 *
 * Row numbers are 1-based and counted *including blank lines* — this matches
 * the Python parser's `enumerate(csv.DictReader(f), start=1)` semantics,
 * which increments the counter for every CSV row but only yields non-empty
 * ones. Without this alignment, blank lines in the source file shift Papa's
 * indices relative to Python's, and a retry/export would address the wrong
 * row of the CSV.
 */
async function readSourceFile(fileId: string, delimiter: string, encoding: string): Promise<{
  headers: string[]
  rows: Map<number, Record<string, string>>
}> {
  const content = await window.api.files.read(fileId, encoding)
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    delimiter: delimiter || ',',
    skipEmptyLines: false,
  })
  const headers = parsed.meta.fields || []
  const rows = new Map<number, Record<string, string>>()
  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i]
    const idx = i + 1
    // Mirror Python's "skip blank lines but keep the counter going": only
    // store rows that have at least one non-empty value, but never reuse
    // an index for a different row.
    const hasValue = row && Object.values(row).some(v => v != null && v !== '')
    if (!hasValue) continue
    rows.set(idx, row)
  }
  return { headers, rows }
}

/**
 * Collect failed row data grouped by filename.
 * Returns the parsed rows keyed by filename, plus merged headers.
 */
async function collectFailedRows(): Promise<{
  byFile: Map<string, { rows: Array<{ rowNum: number; data: Record<string, string> }>; headers: string[] }>
  allHeaders: string[]
}> {
  // Group errors by filename
  const errorsByFile = new Map<string, number[]>()
  for (const err of run.downloadErrors) {
    if (err.rowNumber <= 0) continue
    const list = errorsByFile.get(err.filename) || []
    list.push(err.rowNumber)
    errorsByFile.set(err.filename, list)
  }

  const byFile = new Map<string, { rows: Array<{ rowNum: number; data: Record<string, string> }>; headers: string[] }>()
  const allHeaderSet = new Set<string>()
  const encoding = config.settings.encoding || 'utf-8'

  for (const [filename, rowNumbers] of errorsByFile) {
    const file = filesStore.files.find(f => f.name === filename)
    if (!file) continue
    const analysis = filesStore.getAnalysis(file.id)
    const delimiter = analysis?.delimiter || config.settings.delimiter || ','

    const { headers, rows: allRows } = await readSourceFile(file.id, delimiter, encoding)
    headers.forEach(h => allHeaderSet.add(h))

    const failedRows: Array<{ rowNum: number; data: Record<string, string> }> = []
    const seen = new Set<number>()
    for (const rowNum of rowNumbers) {
      if (seen.has(rowNum)) continue
      seen.add(rowNum)
      const row = allRows.get(rowNum)
      if (row) failedRows.push({ rowNum, data: row })
    }

    if (failedRows.length > 0) {
      byFile.set(filename, { rows: failedRows, headers })
    }
  }

  return { byFile, allHeaders: [...allHeaderSet] }
}

/**
 * Map each error row to the failure message(s) for that row, by filename.
 * Used to attach an __import_error__ column to the exported failed rows.
 */
function buildErrorLookup(): Map<string, Map<number, string[]>> {
  const grouped = new Map<string, Map<number, string[]>>()
  for (const err of run.downloadErrors) {
    if (err.rowNumber <= 0) continue
    if (!grouped.has(err.filename)) grouped.set(err.filename, new Map())
    const byRow = grouped.get(err.filename)!
    if (!byRow.has(err.rowNumber)) byRow.set(err.rowNumber, [])
    byRow.get(err.rowNumber)!.push(err.error)
  }
  return grouped
}

/**
 * Build a ZIP archive containing one CSV per source file. Each CSV keeps
 * the original filename (with .csv extension forced if missing), the
 * original header order, and a trailing __import_error__ column.
 *
 * Restored from the 16.0 export feature that was lost during the python-refactor.
 */
async function exportFailedRowsZip() {
  if (isExporting.value) return

  const errorLookup = buildErrorLookup()
  if (errorLookup.size === 0) {
    showAlert(t('results.noFailedRowsToExport'))
    return
  }

  isExporting.value = true
  try {
    const { byFile } = await collectFailedRows()
    if (byFile.size === 0) {
      const missing = [...errorLookup.keys()].join(', ')
      showAlert(t('results.failedRowsExportNoFiles', { files: missing || '—' }))
      return
    }

    const zip = new JSZip()
    const missingFiles: string[] = []

    // Detect which files we expected (from errorLookup) but couldn't load
    // their source files in collectFailedRows.
    for (const filename of errorLookup.keys()) {
      if (!byFile.has(filename)) missingFiles.push(filename)
    }

    for (const [filename, { rows, headers }] of byFile) {
      const rowErrors = errorLookup.get(filename) ?? new Map()
      const failedRows = rows.map(({ rowNum, data }) => ({
        rowNumber: rowNum,
        data,
        error: (rowErrors.get(rowNum) ?? []).join(' | '),
      }))
      if (failedRows.length === 0) continue
      const exportName = filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`
      zip.file(exportName, buildFailedRowsCsv(headers, failedRows))
    }

    if (Object.keys(zip.files).length === 0) {
      if (missingFiles.length > 0) {
        showAlert(t('results.failedRowsExportNoFiles', { files: missingFiles.join(', ') }))
      } else {
        showAlert(t('results.noFailedRowsToExport'))
      }
      return
    }

    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, 'import-failed-rows.zip')

    if (missingFiles.length > 0) {
      showAlert(t('results.failedRowsExportPartial', { files: missingFiles.join(', ') }))
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger.import.error('Failed to export failed rows ZIP', { error: message })
    showAlert(t('results.failedRowsExportError', { error: message }))
  } finally {
    isExporting.value = false
  }
}

async function retryFailedRows() {
  if (isRetrying.value) return

  const hasFiles = filesStore.files.length > 0
  if (!hasFiles) {
    showAlert(t('results.retryNoFiles'))
    return
  }

  isRetrying.value = true
  run.isHistoricalLog = false

  try {
    if (session.isEmbedded) {
      // Addon mode: server-side retry (re-processes only failed rows)
      const resp = await window.api.odoo.call<{ logId: number; state: string }>({
        baseUrl: '',
        endpoint: '/ametras_fast_import/import/retry',
        params: { log_id: run.logId }
      })

      if (resp.ok && resp.result) {
        run.reset()
        run.logId = resp.result.logId
        run.setState(ImportState.RUNNING_FILE)
        router.push('/run')
      } else {
        showAlert(resp.error || t('results.retryFailed'))
        isRetrying.value = false
      }
    } else {
      // Standalone mode: collect failed rows and re-import via Python
      const { byFile } = await collectFailedRows()
      if (byFile.size === 0) {
        showAlert(t('results.retryNoFiles'))
        isRetrying.value = false
        return
      }

      // Store retry data, then reset (reset clears retryRows, so re-set after)
      run.reset()
      run.retryRows = byFile
      run.setState(ImportState.RUNNING_FILE)
      router.push('/run')
    }
  } catch (e) {
    logger.import.error('Retry failed', { error: e instanceof Error ? e.message : String(e) })
    showAlert(t('results.retryFailed'))
    isRetrying.value = false
  }
}

// ── Post-import validation ──────────────────────────────────────────

const canValidate = computed(
  () => session.isEmbedded && run.isCompleted && !run.isDryRun && !!run.logId,
)

/** Flattened mismatch rows across all files, each tagged with its filename. */
const validationMismatches = computed(() => {
  const result = run.validationResult
  if (!result?.perFile) return []
  const out: Array<{ filename: string; rowNumber: number; field: string; intended: unknown; stored: unknown; kind: string }> = []
  for (const [filename, report] of Object.entries(result.perFile)) {
    for (const m of report.mismatches || []) {
      out.push({ filename, rowNumber: m.rowNumber, field: m.field, intended: m.intended, stored: m.stored, kind: m.kind })
    }
  }
  return out
})

const validationUnvalidatable = computed(() => run.validationResult?.unvalidatable ?? 0)

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === false || v === '') return '∅'
  return String(v)
}

async function pollValidation() {
  if (!run.logId) return
  const res = await getImportValidation(run.logId)
  if (!res) {
    isValidating.value = false
    return
  }
  run.setValidation(res.state, res.result)
  if (res.state === 'running') {
    validationPollTimer = setTimeout(pollValidation, 1500)
  } else {
    isValidating.value = false
  }
}

async function validateImport() {
  if (isValidating.value || !run.logId) return
  isValidating.value = true
  run.setValidation('running', null)
  try {
    const started = await startImportValidation(run.logId)
    if (!started) {
      run.setValidation('error', null)
      isValidating.value = false
      showAlert(t('results.validationStartFailed'))
      return
    }
    pollValidation()
  } catch (e) {
    logger.import.error('Validate failed', { error: e instanceof Error ? e.message : String(e) })
    run.setValidation('error', null)
    isValidating.value = false
    showAlert(t('results.validationStartFailed'))
  }
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
      <Card v-if="run.errors.length > 0" class="p-3">
        <h3 class="fw-semibold mb-3">{{ $t('results.export') }}</h3>

        <div class="d-flex gap-3">
          <Button
            variant="outline"
            @click="exportErrorsCSV"
          >
            {{ $t('results.downloadErrors') }}
          </Button>

          <Button
            variant="outline"
            :disabled="isExporting"
            @click="exportFailedRowsZip"
          >
            {{ $t('results.downloadFailedRowsZip') }}
          </Button>
        </div>
      </Card>

      <!-- Error Details -->
      <Card v-if="run.errors.length > 0" class="p-3">
        <h3 class="fw-semibold mb-3">
          {{ $t('results.errors') }} ({{ run.errors.length.toLocaleString() }})
        </h3>

        <!-- Truncation notice: shown when the in-memory cap was hit -->
        <div
          v-if="hasTruncatedErrors"
          class="alert alert-warning d-flex align-items-start gap-2 mb-3 py-2 px-3"
          role="alert"
        >
          <span class="flex-grow-1">
            {{ $t('results.errorsCap', { shown: run.errors.length.toLocaleString(), total: run.totalErrorsSeen.toLocaleString() }) }}
          </span>
          <Button variant="outline" size="sm" @click="exportFailedRowsZip">
            {{ $t('results.downloadFailedRowsZip') }}
          </Button>
        </div>

        <div class="overflow-auto" style="max-height: 32rem;">
          <!-- One section per file when multiple files have errors -->
          <template v-if="errorsByFilename.size > 1">
            <div
              v-for="[filename, fileErrors] in errorsByFilename"
              :key="filename"
              class="mb-4"
            >
              <h4 class="fs-6 fw-semibold text-secondary mb-1 d-flex align-items-baseline gap-2">
                {{ filename }}
                <span class="badge bg-danger-subtle text-danger-emphasis fw-normal">
                  {{ fileErrors.length.toLocaleString() }}
                </span>
              </h4>
              <Table>
                <thead>
                  <tr>
                    <th class="text-end" style="width: 5rem;">{{ $t('results.row') }}</th>
                    <th class="text-start">{{ $t('results.error') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(error, idx) in fileErrors" :key="idx">
                    <td class="text-end">{{ error.rowNumber }}</td>
                    <td class="text-danger">{{ error.error }}</td>
                  </tr>
                </tbody>
              </Table>
            </div>
          </template>

          <!-- Flat table when only one file -->
          <Table v-else>
            <thead>
              <tr>
                <th class="text-end" style="width: 5rem;">{{ $t('results.row') }}</th>
                <th class="text-start">{{ $t('results.error') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(error, idx) in run.errors" :key="idx">
                <td class="text-end">{{ error.rowNumber }}</td>
                <td class="text-danger">{{ error.error }}</td>
              </tr>
            </tbody>
          </Table>
        </div>
      </Card>

      <!-- Post-import validation -->
      <Card v-if="canValidate || run.validationState !== 'not_run'" class="p-3">
        <div class="d-flex align-items-center justify-content-between mb-2">
          <h3 class="fw-semibold mb-0">{{ $t('results.validationResults') }}</h3>
          <span v-if="run.validationState === 'passed'" class="badge bg-success-subtle text-success-emphasis">
            {{ $t('results.validationPassed') }}
          </span>
          <span v-else-if="run.validationState === 'failed'" class="badge bg-danger-subtle text-danger-emphasis">
            {{ $t('results.validationFailedBadge') }}
          </span>
          <span v-else-if="run.validationState === 'error'" class="badge bg-danger-subtle text-danger-emphasis">
            {{ $t('results.validationError') }}
          </span>
          <span v-else-if="run.validationState === 'running'" class="badge bg-secondary-subtle text-secondary-emphasis">
            {{ $t('results.validating') }}
          </span>
        </div>

        <p v-if="run.validationState === 'not_run'" class="text-secondary small mb-0">
          {{ $t('results.validationHint') }}
        </p>

        <template v-if="run.validationResult">
          <p class="small text-secondary mb-2">
            {{ $t('results.validationSummary', {
              checked: run.validationResult.checked,
              ok: run.validationResult.ok,
              mismatched: run.validationResult.failedRows,
            }) }}
          </p>

          <div v-if="validationMismatches.length" class="overflow-auto" style="max-height: 24rem;">
            <Table>
              <thead>
                <tr>
                  <th class="text-end" style="width: 5rem;">{{ $t('results.row') }}</th>
                  <th class="text-start">{{ $t('results.field') }}</th>
                  <th class="text-start">{{ $t('results.intended') }}</th>
                  <th class="text-start">{{ $t('results.stored') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(m, idx) in validationMismatches" :key="idx">
                  <td class="text-end">{{ m.rowNumber }}</td>
                  <td><code>{{ m.field }}</code></td>
                  <td>{{ fmtValue(m.intended) }}</td>
                  <td :class="m.kind === 'dropped' ? 'text-danger fw-semibold' : ''">
                    {{ fmtValue(m.stored) }}
                  </td>
                </tr>
              </tbody>
            </Table>
          </div>

          <p v-if="validationUnvalidatable" class="small text-secondary mt-2 mb-0">
            {{ $t('results.validationUnvalidatable', { count: validationUnvalidatable }) }}
          </p>
        </template>
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
          <Button
            v-if="canValidate"
            variant="outline"
            :disabled="isValidating"
            @click="validateImport"
          >
            {{ isValidating ? $t('results.validating') : $t('results.validateImport') }}
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
          <Button
            v-if="canValidate"
            variant="outline"
            :disabled="isValidating"
            @click="validateImport"
          >
            {{ isValidating ? $t('results.validating') : $t('results.validateImport') }}
          </Button>
          <Button @click="startNew">
            {{ run.isHistoricalLog ? $t('results.close') : $t('results.startNew') }}
          </Button>
        </template>
      </div>
    </template>
  </div>
</template>
