<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { NavigationGuardNext, RouteLocationNormalized } from 'vue-router'
import { useRunStore } from '@/stores/run'
import { useFilesStore } from '@/stores/files'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { ImportState } from '@/types/importState'
import { formatNumber } from '@/utils/formatters'
import { logger } from '@/utils/logger'
import { Button, Progress, Card, Table } from '@/ui'

const { t } = useI18n()

const router = useRouter()
const run = useRunStore()
const filesStore = useFilesStore()
const config = useConfigStore()
const session = useSessionStore()

// Polling with exponential backoff on failure
const BASE_POLL_INTERVAL = 500
const MAX_POLL_INTERVAL = 10_000
let pollTimer: ReturnType<typeof setTimeout> | null = null
let consecutivePollFailures = 0

// Error state
const initError = ref<string | null>(null)

// Startup watchdog (90s with no progress)
const WATCHDOG_TIMEOUT = 90_000
let watchdogTimer: ReturnType<typeof setTimeout> | null = null

// Offline elapsed time tracking
const offlineElapsed = ref('')
let offlineSince: number | null = null
let offlineInterval: ReturnType<typeof setInterval> | null = null
// Countdown to next retry attempt
const retryCountdown = ref(0)
let retryCountdownEnd: number | null = null

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
        if (retryCountdownEnd !== null) {
          retryCountdown.value = Math.max(0, Math.ceil((retryCountdownEnd - Date.now()) / 1000))
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
  if (seconds === null) {
    // Distinguish "calculating" from "no data"
    return run.globalProgress > 0 ? '--' : t('run.state.initiating')
  }
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}m ${secs}s`
})

const throughputDisplay = computed(() => {
  const rps = run.throughput
  if (!rps) return null
  return `~${formatNumber(rps)} rows/s`
})

// Addon mode supports pause/resume/skip via server; Python mode only supports skip + cancel
const supportsServerControl = computed(() => session.isEmbedded)

const fileProgressList = computed(() =>
  Object.values(run.progress.files)
)

const isRunning = computed(() =>
  [ImportState.VALIDATING, ImportState.RUNNING_FILE].includes(run.state)
)

const isTransitioning = ref(false)

// Auto-navigate when import reaches a terminal state
watch(() => run.state, (newState) => {
  if (newState === ImportState.RUNNING_FILE) {
    startWatchdog() // restart 90s from when job actually begins, not from user click
  } else if (newState === ImportState.COMPLETED || newState === ImportState.FAILED) {
    stopPolling()
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null }
    window.api?.odoo?.pinSession?.({ baseUrl: session.baseUrl || '', pinned: false })
    router.push('/results')
  } else if (newState === ImportState.INTERRUPTED) {
    stopPolling()
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null }
    window.api?.odoo?.pinSession?.({ baseUrl: session.baseUrl || '', pinned: false })
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
        if (consecutivePollFailures > 0) {
          consecutivePollFailures = 0
          run.connectionStatus = 'online'
        }
        clearWatchdog()
      } else {
        // odoo.call resolves {ok: false} on network/timeout errors (doesn't throw)
        consecutivePollFailures++
        run.connectionStatus = 'offline'
        if (resp.error) logger.import.warn('Poll failed', { error: resp.error })
      }
    } catch (e) {
      consecutivePollFailures++
      run.connectionStatus = 'offline'
      logger.import.warn('Failed to poll progress', { error: (e as Error).message })
    }
  } else if (window.api?.python?.progress) {
    // Electron mode: drain progress messages from Python subprocess
    try {
      const messages = await window.api.python.progress()
      let gotProgress = false
      for (const msg of messages) {
        const m = msg as Record<string, unknown>
        if (m.type === 'progress') {
          gotProgress = true
          const total = (m.total as number) || 0
          const success = (m.success as number) || 0
          const failed = (m.failed as number) || 0
          // Attribute to currentPythonFile (set by runPythonImport, not by queued messages)
          const filename = currentPythonFile.value || ''
          if (filename) {
            run.updateFileProgress(filename, {
              processedRows: success + failed,
              successCount: success,
              failedCount: failed,
            })
            const fp = run.progress.files[filename]
            if (fp && total > 0) fp.totalRows = total
          }
        } else if (m.type === 'batch_errors') {
          const batchErrors = (m.errors as Array<{ row: number; error: string }>) || []
          const filename = currentPythonFile.value || ''
          if (filename) {
            for (const e of batchErrors) {
              run.addError({ filename, rowNumber: e.row, rawData: {}, error: e.error, timestamp: Date.now() })
            }
          }
        } else if (m.type === 'file_start' || m.type === 'file_done') {
          // Ignored — runPythonImport controls file lifecycle directly via
          // run.startFile()/completeFile(). Processing these queued messages
          // would double-count completedFiles and cause stale attribution.
        } else if (m.type === 'connection_lost') {
          run.connectionStatus = 'offline'
        } else if (m.type === 'connection_restored') {
          run.connectionStatus = 'online'
        }
      }
      // Progress messages arriving means Python→Odoo RPC calls are succeeding.
      // If the banner was stuck (connection_restored never sent after partial reconnect),
      // clear it now that the import is visibly making progress.
      if (gotProgress && run.connectionStatus === 'offline') {
        run.connectionStatus = 'online'
      }
      // Record progress sample for ETA/throughput in Python mode
      run.recordProgressSample()
      clearWatchdog()
    } catch {
      // Ignore polling errors for local subprocess
    }
  }

  // Schedule next poll (with backoff on failures)
  schedulePoll()
}

// Track current file for Python subprocess progress
const currentPythonFile = ref('')

function getPollInterval(): number {
  if (consecutivePollFailures <= 0) return BASE_POLL_INTERVAL
  return Math.min(BASE_POLL_INTERVAL * Math.pow(2, consecutivePollFailures), MAX_POLL_INTERVAL)
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer)
  if (!run.isActive) return
  const delay = getPollInterval()
  pollTimer = setTimeout(pollProgress, delay)
  if (consecutivePollFailures > 0) {
    retryCountdownEnd = Date.now() + delay
    retryCountdown.value = Math.ceil(delay / 1000)
  } else {
    retryCountdownEnd = null
    retryCountdown.value = 0
  }
}

function startPolling() {
  stopPolling()
  consecutivePollFailures = 0
  schedulePoll()
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function startWatchdog() {
  clearWatchdog()
  watchdogTimer = setTimeout(() => {
    const hasProgress = Object.values(run.progress.files).some(f => f.processedRows > 0)
    if (!hasProgress && run.state === ImportState.RUNNING_FILE) {
      // Cancel the stuck import so "Try Again" doesn't double-start
      controlImport('cancel')
      stopPolling()
      initError.value = t('run.startupTimeout')
    }
  }, WATCHDOG_TIMEOUT)
}

function clearWatchdog() {
  // Clear once we see any progress
  const hasProgress = Object.values(run.progress.files).some(f => f.processedRows > 0)
  if (hasProgress && watchdogTimer) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
}

async function startImport() {
  initError.value = null

  // Capture retry data before reset() clears it
  const pendingRetry = run.retryRows
  run.reset()
  logger.clear()

  if (!pendingRetry && filesStore.files.length === 0) {
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
        logger.import.info('job_start', { logId: resp.result.logId, mode: 'embedded', files: importConfig.importSequence?.length ?? 0 })
        startPolling()
        startWatchdog()
      } else {
        initError.value = resp.error || 'Failed to start import'
      }
    } else if (typeof window.api?.python?.import === 'function') {
      // Electron standalone mode: run import via Python subprocess.
      run.setState(ImportState.RUNNING_FILE)
      run.runStartTime = Date.now()

      // Check if this is a retry with pre-collected failed rows
      if (pendingRetry) {
        const filenames = [...pendingRetry.keys()]
        const rowCounts = new Map<string, number>()
        for (const [fname, { rows }] of pendingRetry) rowCounts.set(fname, rows.length)
        run.initRun(filenames, rowCounts, config.settings.dryRun)
      } else {
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
      }

      startPolling()
      startWatchdog()
      window.api?.odoo?.pinSession?.({ baseUrl: session.baseUrl || '', pinned: true })

      const importFn = pendingRetry ? () => runPythonRetry(pendingRetry) : runPythonImport
      importFn().catch(e => {
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

type RetryData = Map<string, { rows: Array<{ rowNum: number; data: Record<string, string> }>; headers: string[] }>

/**
 * Retry failed rows via Python subprocess using raw_rows mode.
 * Sends only the previously failed rows for each file.
 */
async function runPythonRetry(retryData: RetryData) {
  pythonCancelled = false
  const runId = ++currentRunId
  let totalFailed = 0

  try {
    for (const [filename, { rows }] of retryData) {
      if (pythonCancelled) break

      const mapping = config.fileMappings[filename]
      if (!mapping) continue

      currentPythonFile.value = filename
      run.startFile(filename)

      // Build raw_rows with original row indices so error reports reference
      // the original CSV row numbers, not the retry subset indices.
      const rawRows = rows.map(r => r.data)
      const rowIndices = rows.map(r => r.rowNum)
      const importPayload = JSON.parse(JSON.stringify({
        url: session.baseUrl,
        db: session.currentServer?.db,
        model: mapping.model,
        raw_rows: rawRows,
        row_indices: rowIndices,
        field_mappings: mapping.fieldMappings || {},
        search_keys: mapping.searchKeys || null,
        use_external_id: mapping.fieldMappings && Object.values(mapping.fieldMappings).includes('id'),
        dry_run: config.settings.dryRun || false,
        strict: mapping.strict || false,
      }))

      const result = await window.api.python.import(importPayload) as unknown as Record<string, unknown>
      await pollProgress()

      if (result.type === 'done') {
        const success = (result.success as number) || 0
        const failed = (result.failed as number) || 0
        totalFailed += failed
        run.updateFileProgress(filename, { processedRows: success + failed, successCount: success, failedCount: failed })
        run.completeFile(filename)

        const errors = (result.errors as Array<{ row: number; error: string }>) || []
        for (const e of errors) {
          run.addError({ filename, rowNumber: e.row, rawData: {}, error: e.error, timestamp: Date.now() })
        }
      } else if (result.type === 'error') {
        const errorMsg = (result.message as string) || 'Retry failed'
        if (pythonCancelled) break
        logger.import.error(`${filename}: ${errorMsg}`)
        run.addError({ filename, rowNumber: 0, rawData: {}, error: errorMsg, timestamp: Date.now() })
        run.completeFile(filename)
      }

      if (pythonCancelled) break
    }

    currentPythonFile.value = ''
    await pollProgress()

    if (runId === currentRunId && run.state !== ImportState.FAILED) {
      run.setState(totalFailed > 0 || pythonCancelled ? ImportState.FAILED : ImportState.COMPLETED)
    }
  } finally {
    stopPolling()
  }
}

/**
 * Run Python subprocess imports sequentially for all files.
 * Called as a background task — progress is shown via polling.
 */
async function runPythonImport() {
  pythonCancelled = false
  pythonSkipRequested = false
  const runId = ++currentRunId
  let totalFailed = 0
  const allErrors: Array<{ filename: string; rowNumber: number; error: string }> = []

  try {
    for (const filename of config.importSequence) {
      if (pythonCancelled) break

      const file = filesStore.files.find(f => f.name === filename)
      if (!file) continue
      const mapping = config.fileMappings[filename]
      if (!mapping) continue

      pythonSkipRequested = false
      currentPythonFile.value = filename
      run.startFile(filename)
      logger.import.info(`Starting: ${filename}`, { rows: run.progress.files[filename]?.totalRows ?? 0 })

      const importPayload = JSON.parse(JSON.stringify({
        url: session.baseUrl,
        db: session.currentServer?.db,
        model: mapping.model,
        file_path: file.id,
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

      // Flush queued progress messages for this file before processing the result.
      // Without this, stale progress from file A could be attributed to file B
      // when the next iteration changes currentPythonFile.
      await pollProgress()

      // Skip requested: mark file skipped, restart subprocess for next file
      if (pythonSkipRequested && !pythonCancelled) {
        logger.import.info(`${filename}: Skipped by user`)
        run.skipFile(filename)
        pythonSkipRequested = false
        // Subprocess was killed by controlImport('skip') — it will be restarted
        // automatically by ensurePythonStarted() on next python:import call
        continue
      }

      if (result.type === 'done') {
        const success = (result.success as number) || 0
        const failed = (result.failed as number) || 0
        totalFailed += failed

        run.updateFileProgress(filename, {
          processedRows: success + failed,
          successCount: success,
          failedCount: failed,
        })
        run.completeFile(filename)

        if (failed > 0) {
          logger.import.warn(`${filename}: import done with errors`, { filename, success, failed, total: success + failed })
        } else {
          logger.import.info(`${filename}: import done`, { filename, success })
        }

        const errors = (result.errors as Array<{ row: number; error: string; file?: string }>) || []
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
              logger.import.warn(`  Row ${e.row}: ${e.error.substring(0, 200)}`)
            }
          }
        }
        if (seenErrors.size > 5) {
          logger.import.warn(`  ... and ${errors.length - 5} more errors`)
        }
      } else if (result.type === 'error') {
        const errorMsg = (result.message as string) || 'Import failed'

        if (pythonCancelled || errorMsg.includes('exited unexpectedly')) {
          logger.import.info(`${filename}: Import cancelled`)
          break
        }

        // Transport errors: mark as file-level failure (don't retry the whole file —
        // the Python backend already retried individual RPCs with reconnect wait).
        // Re-running the entire file would duplicate already-committed rows.

        logger.import.error(`${filename}: ${errorMsg}`)
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

    // Final poll to drain any remaining progress messages
    await pollProgress()

    if (runId === currentRunId && run.state !== ImportState.FAILED) {
      const finalState = totalFailed > 0 || allErrors.length > 0 || pythonCancelled
        ? ImportState.FAILED
        : ImportState.COMPLETED
      run.setState(finalState)
    }
  } finally {
    stopPolling()
  }
}

// Track cancellation/skip for Python subprocess mode
let pythonCancelled = false
let pythonSkipRequested = false
// Monotonic run counter: guards final setState against stale completions after abort
let currentRunId = 0

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
      // Electron standalone mode
      if (action === 'cancel') {
        pythonCancelled = true
        window.api?.python?.cancel?.()
        run.setState(ImportState.FAILED)
      } else if (action === 'skip') {
        // Kill current file's subprocess; runPythonImport will mark it skipped and continue
        pythonSkipRequested = true
        window.api?.python?.cancel?.()
      }
    }
  } catch (e) {
    logger.import.warn(`Failed to ${action} import`, { error: (e as Error).message })
  } finally {
    setTimeout(() => { isTransitioning.value = false }, BASE_POLL_INTERVAL + 100)
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

  // Guard against page-refresh double-start: check for an already-running job
  // before starting a new one (embedded mode only — standalone manages its own state)
  if (session.isEmbedded) {
    const activeResp = await window.api.odoo.call<{ logs: Array<{ logId: number; state: string; profileName: string }> }>({
      baseUrl: '',
      endpoint: '/ametras_fast_import/import/active',
      params: {}
    })
    if (activeResp.ok && activeResp.result?.logs?.length) {
      const activeLogs = activeResp.result.logs
      if (activeLogs.length === 1) {
        // Re-attach to the single running job
        run.logId = activeLogs[0].logId
        run.setState(activeLogs[0].state === 'paused' ? ImportState.PAUSED : ImportState.RUNNING_FILE)
        startPolling()
        return
      }
      // Multiple active logs — surface as an error rather than picking silently
      initError.value = `Multiple active imports found (IDs: ${activeLogs.map(l => l.logId).join(', ')}). Please cancel the stale jobs before starting a new import.`
      return
    }
  }

  // Otherwise, start a new import
  await startImport()
})

onUnmounted(() => {
  stopPolling()
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null }
  if (offlineInterval) {
    clearInterval(offlineInterval)
    offlineInterval = null
  }
  window.api?.odoo?.pinSession?.({ baseUrl: session.baseUrl || '', pinned: false })
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
      aria-live="assertive"
      aria-atomic="true"
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
        <div v-if="retryCountdown > 0" class="small text-body-secondary mt-1">
          {{ $t('run.retryingIn', { seconds: retryCountdown }) }}
        </div>
      </div>
    </div>

    <!-- Stall Warning Banner -->
    <div
      v-if="run.isStalled"
      class="alert alert-warning d-flex align-items-center gap-3 mb-0"
      role="alert"
      aria-live="assertive"
    >
      <span class="fs-5">⚠</span>
      <div class="flex-grow-1">
        <strong>{{ $t('run.stalledTitle') }}</strong>
        <div class="small">{{ $t('run.stalledDetail') }}</div>
      </div>
      <button
        type="button"
        class="btn btn-sm btn-outline-danger"
        @click="controlImport('cancel')"
      >
        {{ $t('run.forceAbort') }}
      </button>
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
    <Card
      class="p-4"
      aria-live="polite"
      aria-atomic="false"
      :aria-label="$t('run.progressRegionLabel')"
    >
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
          <small v-if="throughputDisplay" class="text-body-secondary d-block">
            {{ throughputDisplay }}
          </small>
        </div>
      </div>

      <Progress
        :value="run.globalProgress * 100"
        size="lg"
        :aria-label="$t('run.progressRegionLabel') as string"
      />

      <div class="d-flex gap-3 mt-3">
        <Button
          v-if="supportsServerControl && run.state === ImportState.PAUSED"
          :disabled="run.isWaitingForConnection"
          @click="handleResume"
        >
          {{ $t('run.resume') }}
        </Button>
        <Button
          v-else-if="supportsServerControl && isRunning"
          variant="outline"
          :disabled="isTransitioning || run.isWaitingForConnection"
          @click="handlePause"
        >
          {{ $t('run.pause') }}
        </Button>
        <Button
          v-if="isRunning"
          variant="outline"
          :disabled="isTransitioning || run.isWaitingForConnection"
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
    <Card v-if="run.errors.length > 0" class="p-4" aria-live="polite" aria-atomic="false">
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
