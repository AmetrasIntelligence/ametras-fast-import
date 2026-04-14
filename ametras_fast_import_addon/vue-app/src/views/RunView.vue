<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { NavigationGuardNext, RouteLocationNormalized } from 'vue-router'
import { useRunStore } from '@/stores/run'
import { useFilesStore } from '@/stores/files'
import { ImportState } from '@/importer/stateMachine'
import { ImportEngine, type ResumeState } from '@/importer/engine'
import { getImportLog } from '@/api/odooClient'
import { formatNumber } from '@/utils/formatters'
import { logger } from '@/utils/logger'
import { Button, Progress, Card, Table } from '@/ui'

const { t } = useI18n()

const router = useRouter()
const run = useRunStore()
const filesStore = useFilesStore()

// Engine initialization error
const initError = ref<string | null>(null)

// Startup watchdog — cleared once import moves past VALIDATING
let startupWatchdogId: ReturnType<typeof setTimeout> | null = null
const STARTUP_TIMEOUT_MS = 90_000

// Throughput display - updated periodically
const throughputDisplay = ref('-- rows/sec')
let throughputInterval: ReturnType<typeof setInterval> | null = null

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
  // Transitional labels override the base state
  if (run.isInitiating) return t('run.state.initiating')
  if (run.isPausing) return t('run.state.pausing')
  if (run.isSkipping) return t('run.state.skipping')

  const labels: Record<ImportState, string> = {
    [ImportState.IDLE]: t('run.state.idle'),
    [ImportState.VALIDATING]: t('run.state.validating'),
    [ImportState.RUNNING_FILE]: t('run.state.running'),
    [ImportState.RUNNING_BATCH]: t('run.state.batch'),
    [ImportState.RETRYING]: t('run.state.retrying'),
    [ImportState.PAUSED]: t('run.state.paused'),
    [ImportState.COMPLETED]: t('run.state.completed'),
    [ImportState.FAILED]: t('run.state.failed')
  }
  return labels[run.state]
})

// Disable pause/skip buttons while a transition is draining
const isTransitioning = computed(() => run.isPausing || run.isSkipping)

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
  [ImportState.VALIDATING, ImportState.RUNNING_FILE, ImportState.RUNNING_BATCH, ImportState.RETRYING].includes(run.state)
)

// Auto-navigate to results when import completes or fails.
// Also clears the startup watchdog once the import is past VALIDATING.
watch(() => run.state, (newState) => {
  if ([ImportState.RUNNING_FILE, ImportState.RUNNING_BATCH, ImportState.RETRYING].includes(newState)) {
    if (startupWatchdogId !== null) {
      clearTimeout(startupWatchdogId)
      startupWatchdogId = null
    }
  }
  if (newState === ImportState.COMPLETED || newState === ImportState.FAILED) {
    router.push('/results')
  }
})

function updateThroughput() {
  if (run.engine && run.isActive) {
    throughputDisplay.value = run.engine.getThroughput().display
  }
}

async function startImport() {
  initError.value = null

  // Always reset before starting: clears stuck, completed, or failed state
  // from a previous attempt. The live-import guard in onMounted ensures this
  // is not called when an import is genuinely running.
  run.reset()

  const files = filesStore.files.map(f => ({
    id: f.id,
    name: f.name
  }))

  if (files.length === 0) {
    router.replace('/import')
    return
  }

  try {
    const newEngine = new ImportEngine()
    run.setEngine(newEngine)

    // Check for resume context
    let resumeState: ResumeState | undefined
    if (run.resumeLogId) {
      const logData = await getImportLog(run.resumeLogId)
      if (logData) {
        resumeState = {
          logId: logData.id,
          fileProgress: logData.file_progress,
          errorLog: logData.error_log,
        }
        logger.import.info(`[resume] Resuming import from log #${logData.id}`)
      }
      run.resumeLogId = null // Clear after use
    }

    // Watchdog: if still stuck in VALIDATING/IDLE after the timeout, the
    // engine has hung somewhere (network call, stream, lock). Abort it and
    // surface an actionable error so the user can retry.
    startupWatchdogId = setTimeout(() => {
      startupWatchdogId = null
      if (run.state === ImportState.VALIDATING || run.state === ImportState.IDLE) {
        logger.import.error('[watchdog] Import startup timed out — aborting')
        newEngine.abort()
        initError.value = t('run.startupTimeout')
      }
    }, STARTUP_TIMEOUT_MS)

    await newEngine.start(files, resumeState)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger.import.error('Import engine error', { error: message })
    // Reset to IDLE so the error card is shown cleanly (state may be
    // VALIDATING if start() threw mid-way through initialisation).
    run.reset()
    initError.value = message
  } finally {
    if (startupWatchdogId !== null) {
      clearTimeout(startupWatchdogId)
      startupWatchdogId = null
    }
  }
}

onMounted(async () => {
  // Start throughput update interval
  throughputInterval = setInterval(updateThroughput, 500)

  // If a live engine is already running, just show its current state
  if (run.isActive && run.engine) {
    return
  }

  await startImport()
})

onUnmounted(() => {
  if (throughputInterval) {
    clearInterval(throughputInterval)
    throughputInterval = null
  }
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
      // User confirmed, abort the import
      run.engine?.abort()
    }
    next()
  }
)

function handlePause() {
  run.engine?.pause()
}

function handleResume() {
  run.engine?.resume()
}

function handleAbort() {
  run.engine?.abort()
  // Show results instead of going back to files
  router.push('/results')
}

function handleSkipFile() {
  run.engine?.skipCurrentFile()
}

function viewResults() {
  router.push('/results')
}
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
            {{ throughputDisplay }}
          </small>
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
          :disabled="run.isPausing"
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
