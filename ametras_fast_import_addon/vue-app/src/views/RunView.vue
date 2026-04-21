<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { NavigationGuardNext, RouteLocationNormalized } from 'vue-router'
import { useRunStore } from '@/stores/run'
import { useFilesStore } from '@/stores/files'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { ImportState } from '@/importer/types'
import { formatNumber } from '@/utils/formatters'
import { logger } from '@/utils/logger'
import { Button, Progress, Card, Table } from '@/ui'

const { t } = useI18n()

const router = useRouter()
const run = useRunStore()
const filesStore = useFilesStore()
const config = useConfigStore()
const session = useSessionStore()

// Polling
const POLL_INTERVAL = 500
let pollTimer: ReturnType<typeof setInterval> | null = null

// Error state
const initError = ref<string | null>(null)

// Offline elapsed time tracking
const offlineElapsed = ref('')
let offlineSince: number | null = null
let offlineInterval: ReturnType<typeof setInterval> | null = null

watch(() => run.connectionStatus, (status) => {
  if (status === 'offline' || status === 'checking') {
    if (!offlineSince) {
      offlineSince = Date.now()
      offlineInterval = setInterval(() => {
        if (offlineSince) {
          const secs = Math.floor((Date.now() - offlineSince) / 1000)
          if (secs < 60) offlineElapsed.value = `${secs}s`
          else offlineElapsed.value = `${Math.floor(secs / 60)}m ${secs % 60}s`
        }
      }, 1000)
    }
  } else {
    offlineSince = null
    offlineElapsed.value = ''
    if (offlineInterval) {
      clearInterval(offlineInterval)
      offlineInterval = null
    }
  }
})

const stateLabel = computed(() => {
  const labels: Record<string, string> = {
    [ImportState.IDLE]: t('run.state.idle'),
    [ImportState.VALIDATING]: t('run.state.validating'),
    [ImportState.RUNNING_FILE]: t('run.state.running'),
    [ImportState.PAUSED]: t('run.state.paused'),
    [ImportState.COMPLETED]: t('run.state.completed'),
    [ImportState.FAILED]: t('run.state.failed'),
    [ImportState.INTERRUPTED]: t('run.state.interrupted'),
  }
  return labels[run.state] || t('run.state.running')
})

const etaDisplay = computed(() => {
  const seconds = run.estimatedTimeRemaining
  if (!seconds) return '--'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}m ${secs}s`
})

const fileProgressList = computed(() =>
  Object.values(run.progress.files)
)

const isRunning = computed(() =>
  [ImportState.VALIDATING, ImportState.RUNNING_FILE].includes(run.state)
)

const isTransitioning = ref(false)

// Auto-navigate when import reaches a terminal state
watch(() => run.state, (newState) => {
  if (newState === ImportState.COMPLETED || newState === ImportState.FAILED) {
    stopPolling()
    router.push('/results')
  } else if (newState === ImportState.INTERRUPTED) {
    stopPolling()
    router.push('/import')
  }
})

async function pollProgress() {
  if (session.isEmbedded) {
    // Addon mode: poll server endpoint
    if (!run.logId) return
    try {
      const resp = await window.api.odoo.call<{
        state: string
        progress: Record<string, { totalRows: number; successCount: number; failedCount: number; processedRanges?: [number, number][]; skipped?: boolean }>
        success_rows: number
        failed_rows: number
        total_rows: number
        current_file: string
        errors: Array<{ filename: string; rowNumber: number; error: string }>
        is_dry_run: boolean
      }>({
        baseUrl: '',
        endpoint: '/ametras_fast_import/import/progress',
        params: { log_id: run.logId }
      })

      if (resp.ok && resp.result) {
        run.updateFromServer(resp.result)
      }
    } catch (e) {
      logger.import.warn('Failed to poll progress', { error: (e as Error).message })
    }
  } else if (window.api?.python?.progress) {
    // Electron mode: drain progress messages from Python subprocess
    try {
      const messages = await window.api.python.progress()
      for (const msg of messages) {
        const m = msg as Record<string, unknown>
        if (m.type === 'progress') {
          // Update progress for current file only — don't overwrite other files
          const total = (m.total as number) || 0
          const success = (m.success as number) || 0
          const failed = (m.failed as number) || 0
          const filename = currentPythonFile.value || ''
          if (filename) {
            run.updateFileProgress(filename, {
              processedRows: success + failed,
              successCount: success,
              failedCount: failed,
            })
            // Update the file's total rows if we got it from Python
            const fp = run.progress.files[filename]
            if (fp && total > 0) {
              fp.totalRows = total
            }
          }
        } else if (m.type === 'file_start') {
          const fname = (m.filename as string) || ''
          currentPythonFile.value = fname
          if (fname) run.startFile(fname)
        } else if (m.type === 'file_done') {
          const fname = (m.filename as string) || ''
          if (fname) run.completeFile(fname)
        }
      }
    } catch {
      // Ignore polling errors
    }
  }
}

// Track current file for Python subprocess progress
const currentPythonFile = ref('')

function startPolling() {
  stopPolling()
  pollTimer = setInterval(pollProgress, POLL_INTERVAL)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function startImport() {
  initError.value = null
  run.reset()

  if (filesStore.files.length === 0) {
    router.replace('/import')
    return
  }

  try {
    if (session.isEmbedded) {
      // Addon mode: start server-side background job via queue_job
      const fileIds = filesStore.files.map(f => parseInt(f.id, 10) || 0).filter(id => id > 0)
      if (fileIds.length === 0) {
        router.replace('/import')
        return
      }
      // Deep-clone to strip Vue reactive proxies — IPC structured clone can't serialize them
      const importConfig = JSON.parse(JSON.stringify({
        fileMappings: config.fileMappings,
        importSequence: config.importSequence,
        settings: config.settings,
        total_rows: filesStore.files.reduce((sum, f) => {
          const analysis = filesStore.getAnalysis(f.id)
          return sum + (analysis?.rowCount || 0)
        }, 0),
      }))

      const resp = await window.api.odoo.call<{ logId: number; state: string }>({
        baseUrl: '',
        endpoint: '/ametras_fast_import/import/start',
        params: {
          file_ids: fileIds,
          config: importConfig,
        }
      })

      if (resp.ok && resp.result) {
        run.logId = resp.result.logId
        run.setState(ImportState.RUNNING_FILE)
        run.runStartTime = Date.now()
        startPolling()
      } else {
        initError.value = resp.error || 'Failed to start import'
      }
    } else if (typeof window.api?.python?.import === 'function') {
      // Electron standalone mode: run import via Python subprocess.
      // Start polling immediately so progress updates show in real-time.
      run.setState(ImportState.RUNNING_FILE)
      run.runStartTime = Date.now()

      // Initialize progress with file info
      const filenames = [...config.importSequence]
      const rowCounts = new Map<string, number>()
      for (const fname of filenames) {
        const file = filesStore.files.find(f => f.name === fname)
        if (file) {
          const analysis = filesStore.getAnalysis(file.id)
          rowCounts.set(fname, analysis?.rowCount || 0)
        }
      }
      run.initRun(filenames, rowCounts, config.settings.dryRun)

      startPolling() // Poll python:progress for real-time updates

      // Run imports in background (don't await each one — let polling show progress)
      runPythonImport().catch(e => {
        logger.import.error('Python import failed', { error: (e as Error).message })
        initError.value = (e as Error).message
        run.setState(ImportState.FAILED)
      })
    } else {
      initError.value = 'No import method available. Install the addon or ensure Python is available.'
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger.import.error('Failed to start import', { error: message })
    initError.value = message
  }
}

/**
 * Run Python subprocess imports sequentially for all files.
 * Called as a background task — progress is shown via polling.
 */
async function runPythonImport() {
  pythonCancelled = false
  let totalSuccess = 0
  let totalFailed = 0
  const allErrors: Array<{ filename: string; rowNumber: number; error: string }> = []

  for (const filename of config.importSequence) {
    if (pythonCancelled) break

    const file = filesStore.files.find(f => f.name === filename)
    if (!file) continue
    const mapping = config.fileMappings[filename]
    if (!mapping) continue

    currentPythonFile.value = filename
    run.startFile(filename)

    const importPayload = JSON.parse(JSON.stringify({
      url: session.baseUrl,
      db: session.currentServer?.db,
      model: mapping.model,
      file_path: file.id, // Resolved to real path by python:import IPC handler
      field_mappings: mapping.fieldMappings || {},
      search_keys: mapping.searchKeys || null,
      use_external_id: mapping.fieldMappings && Object.values(mapping.fieldMappings).includes('id'),
      dry_run: config.settings.dryRun || false,
      strict: mapping.strict || false,
      batch_size: config.settings.batchSize || 200,
      delimiter: config.settings.delimiter || ',',
      encoding: config.settings.encoding || 'utf-8',
    }))

    const result = await window.api.python.import(importPayload) as unknown as Record<string, unknown>

    if (result.type === 'done') {
      const success = (result.success as number) || 0
      const failed = (result.failed as number) || 0
      totalSuccess += success
      totalFailed += failed

      run.updateFileProgress(filename, {
        processedRows: success + failed,
        successCount: success,
        failedCount: failed,
      })
      run.completeFile(filename)

      // Log to browser DevTools console
      if (failed > 0) {
        console.warn(`[import] ${filename}: ${success}/${success + failed} rows imported, ${failed} failed`)
      } else {
        console.log(`[import] ${filename}: ${success} rows imported successfully`)
      }

      const errors = (result.errors as Array<{ row: number; error: string; file?: string }>) || []
      // Log first 5 unique errors to console
      const seenErrors = new Set<string>()
      for (const e of errors) {
        allErrors.push({ filename, rowNumber: e.row, error: e.error })
        run.addError({
          filename,
          rowNumber: e.row,
          rawData: {},
          error: e.error,
          timestamp: Date.now(),
        })
        const key = e.error.substring(0, 80)
        if (!seenErrors.has(key)) {
          seenErrors.add(key)
          if (seenErrors.size <= 5) {
            console.warn(`[import]   Row ${e.row}: ${e.error.substring(0, 200)}`)
          }
        }
      }
      if (seenErrors.size > 5) {
        console.warn(`[import]   ... and ${errors.length - 5} more errors`)
      }
    } else if (result.type === 'error') {
      const errorMsg = (result.message as string) || 'Import failed'

      // If the process was killed (cancel/navigate away), don't log as file error
      if (pythonCancelled || errorMsg.includes('exited unexpectedly')) {
        console.log(`[import] ${filename}: Import cancelled`)
        break
      }

      console.error(`[import] ${filename}: ${errorMsg}`)
      run.addError({
        filename,
        rowNumber: 0,
        rawData: {},
        error: errorMsg,
        timestamp: Date.now(),
      })
      run.completeFile(filename)
    }

    if (pythonCancelled) break
  }

  currentPythonFile.value = ''
  stopPolling()

  // Final poll to drain any remaining progress messages
  await pollProgress()

  // Don't override state if already set to FAILED by cancel
  if (run.state !== ImportState.FAILED) {
    const finalState = totalFailed > 0 || allErrors.length > 0 || pythonCancelled
      ? ImportState.FAILED
      : ImportState.COMPLETED
    run.setState(finalState)
  }
  // Navigation handled by the state watcher
}

// Track cancellation for Python subprocess mode
let pythonCancelled = false

async function controlImport(action: string) {
  isTransitioning.value = true
  try {
    if (session.isEmbedded && run.logId) {
      // Addon mode: control via server endpoint
      await window.api.odoo.call({
        baseUrl: '',
        endpoint: '/ametras_fast_import/import/control',
        params: { log_id: run.logId, action }
      })
    } else {
      // Electron standalone: cancel by killing Python subprocess.
      if (action === 'cancel') {
        pythonCancelled = true
        // Kill the subprocess immediately — don't wait for current file
        window.api?.python?.cancel?.()
        run.setState(ImportState.FAILED)
        // State change triggers watcher → navigation to /results
      }
      // Pause/resume/skip not supported in subprocess mode
    }
  } catch (e) {
    logger.import.warn(`Failed to ${action} import`, { error: (e as Error).message })
  } finally {
    setTimeout(() => { isTransitioning.value = false }, POLL_INTERVAL + 100)
  }
}

function handlePause() { controlImport('pause') }
function handleResume() { controlImport('resume') }
function handleSkipFile() { controlImport('skip') }

function handleAbort() {
  controlImport('cancel')
}

function viewResults() {
  router.push('/results')
}

onMounted(async () => {
  // If we already have a logId (set by ImportView or resume), start polling
  if (run.logId && run.isActive) {
    startPolling()
    return
  }

  // Otherwise, start a new import
  await startImport()
})

onUnmounted(() => {
  stopPolling()
  if (offlineInterval) {
    clearInterval(offlineInterval)
    offlineInterval = null
  }
})

// Warn before leaving during active import
onBeforeRouteLeave(
  (_to: RouteLocationNormalized, _from: RouteLocationNormalized, next: NavigationGuardNext) => {
    if (run.isActive) {
      const confirmed = window.confirm(t('run.leaveWarning'))
      if (!confirmed) {
        next(false)
        return
      }
      controlImport('cancel')
    }
    next()
  }
)
</script>

<template>
  <div class="p-4 d-flex flex-column gap-4">
    <!-- Connection Lost Banner -->
    <div
      v-if="run.isWaitingForConnection"
      class="alert alert-warning d-flex align-items-center gap-3 mb-0"
      role="alert"
    >
      <div class="spinner-border spinner-border-sm text-warning" role="status">
        <span class="visually-hidden">{{ $t('run.reconnecting') }}</span>
      </div>
      <div>
        <strong>{{ $t('run.connectionLost') }}</strong>
        <div class="small">{{ $t('run.connectionLostDetail') }}</div>
        <div v-if="offlineElapsed" class="small text-body-secondary mt-1">
          {{ offlineElapsed }}
        </div>
      </div>
    </div>

    <!-- Init Error -->
    <Card v-if="initError" class="p-4">
      <div class="alert alert-danger mb-0">
        <strong>{{ $t('run.state.failed') }}</strong>
        <div class="small mt-1">{{ initError }}</div>
      </div>
      <div class="d-flex gap-2 mt-3">
        <Button @click="startImport">
          {{ $t('run.tryAgain') }}
        </Button>
        <Button variant="outline" @click="router.push('/import')">
          {{ $t('nav.import') }}
        </Button>
      </div>
    </Card>

    <!-- Global Progress -->
    <Card class="p-4">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <div>
          <div class="d-flex align-items-center gap-2">
            <h2 class="fs-5 fw-semibold mb-0">{{ stateLabel }}</h2>
            <span
              v-if="run.isDryRun"
              class="badge rounded-pill text-bg-warning"
            >
              {{ $t('run.dryRun') }}
            </span>
          </div>
          <small class="text-body-secondary">
            {{ $t('run.fileProgress', { completed: run.progress.completedFiles, total: run.progress.totalFiles }) }}
          </small>
        </div>
        <div class="text-end">
          <div class="fs-4 fw-bold">
            {{ Math.round(run.globalProgress * 100) }}%
          </div>
          <small class="text-body-secondary d-block">
            {{ $t('run.eta') }}: {{ etaDisplay }}
          </small>
        </div>
      </div>

      <Progress
        :value="run.globalProgress * 100"
        size="lg"
      />

      <div class="d-flex gap-3 mt-3">
        <Button
          v-if="run.state === ImportState.PAUSED"
          @click="handleResume"
        >
          {{ $t('run.resume') }}
        </Button>
        <Button
          v-else-if="isRunning"
          variant="outline"
          :disabled="isTransitioning"
          @click="handlePause"
        >
          {{ $t('run.pause') }}
        </Button>
        <Button
          v-if="isRunning"
          variant="outline"
          :disabled="isTransitioning"
          @click="handleSkipFile"
        >
          {{ $t('run.skipFile') }}
        </Button>
        <Button
          v-if="isRunning || run.state === ImportState.PAUSED"
          variant="destructive"
          @click="handleAbort"
        >
          {{ $t('run.abort') }}
        </Button>
        <Button
          v-if="run.state === ImportState.COMPLETED || run.state === ImportState.FAILED"
          @click="viewResults"
        >
          {{ $t('run.viewResults') }}
        </Button>
      </div>
    </Card>

    <!-- Per-File Progress -->
    <Card class="p-4">
      <h3 class="fw-semibold mb-3">{{ $t('run.filesTable.title') }}</h3>

      <Table>
        <thead>
          <tr>
            <th class="text-start">{{ $t('run.filesTable.file') }}</th>
            <th class="text-end">{{ $t('run.filesTable.progress') }}</th>
            <th class="text-end">{{ $t('run.filesTable.success') }}</th>
            <th class="text-end">{{ $t('run.filesTable.failed') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="file in fileProgressList"
            :key="file.filename"
            :class="{
              'table-primary': run.currentFile?.filename === file.filename,
              'table-secondary opacity-50': file.skipped
            }"
          >
            <td>
              {{ file.filename }}
              <span v-if="file.skipped" class="badge bg-secondary ms-2" style="font-size: 0.625rem;">{{ $t('run.skipped') }}</span>
            </td>
            <td class="text-end">
              <span v-if="file.skipped">--</span>
              <span v-else>{{ formatNumber(file.processedRows) }} / {{ formatNumber(file.totalRows) }}</span>
            </td>
            <td class="text-end text-success">
              {{ formatNumber(file.successCount) }}
            </td>
            <td class="text-end text-danger">
              {{ formatNumber(file.failedCount) }}
            </td>
          </tr>
        </tbody>
      </Table>
    </Card>

    <!-- Recent Errors -->
    <Card v-if="run.errors.length > 0" class="p-4">
      <h3 class="fw-semibold mb-3">
        {{ $t('run.recentErrors') }} ({{ run.errors.length }})
      </h3>

      <div class="overflow-auto d-flex flex-column gap-2" style="max-height: 12rem;">
        <div
          v-for="(error, idx) in run.errors.slice(-10).reverse()"
          :key="idx"
          class="p-2 rounded small bg-danger-subtle"
        >
          <div class="fw-medium">
            {{ error.filename }} - {{ $t('run.row') }} {{ error.rowNumber }}
          </div>
          <div class="text-danger">{{ error.error }}</div>
        </div>
      </div>
    </Card>
  </div>
</template>
