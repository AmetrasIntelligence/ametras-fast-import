import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ImportState, type ConnectionStatus } from '@/types/importState'
import {
  getImportLog,
  type ValidationResult,
  type ValidationState,
} from '@/api/odooClient'

export interface FileProgress {
  filename: string
  totalRows: number
  processedRows: number
  successCount: number
  failedCount: number
  retryingCount: number
  skipped?: boolean
  startTime?: number
  endTime?: number
}

export interface RunProgress {
  totalFiles: number
  completedFiles: number
  currentFileIndex: number
  files: Record<string, FileProgress>
}

export interface ImportRowError {
  filename: string
  rowNumber: number
  rawData: Record<string, string>
  error: string
  timestamp: number
}

export interface TimeoutMitigationStatus {
  code: string
  batchSize?: number
  level?: number
}

// ETA smoothing: sliding window of progress samples
interface ProgressSample { time: number; progress: number }
const MAX_SAMPLES = 20

export const MAX_ERRORS = 5_000

export const useRunStore = defineStore('run', () => {
  const state = ref<ImportState>(ImportState.IDLE)
  const isDryRun = ref(false)
  const logId = ref<number | null>(null)
  const connectionStatus = ref<ConnectionStatus>('online')
  const resumeLogId = ref<number | null>(null)

  const progress = ref<RunProgress>({
    totalFiles: 0,
    completedFiles: 0,
    currentFileIndex: -1,
    files: {}
  })
  const errors = ref<ImportRowError[]>([])
  /**
   * Full unbounded list of all errors — used for CSV downloads.
   * `errors` is capped at MAX_ERRORS for UI rendering only.
   */
  const downloadErrors = ref<ImportRowError[]>([])
  const errorKeys = new Set<string>()
  /** Total errors seen lifetime; may exceed errors.length when capped. */
  const totalErrorsSeen = ref(0)
  const runStartTime = ref<number | null>(null)
  const isHistoricalLog = ref(false)
  const progressSamples = ref<ProgressSample[]>([])
  /** ISO timestamp of last server heartbeat. null before first poll. */
  const lastHeartbeat = ref<string | null>(null)

  /** Post-import validation (embedded mode). */
  const validationState = ref<ValidationState>('not_run')
  const validationResult = ref<ValidationResult | null>(null)

  function setValidation(state: ValidationState, result: ValidationResult | null) {
    validationState.value = state
    validationResult.value = result
  }

  const timeoutMitigationActive = ref(false)
  const timeoutMitigationStatus = ref<TimeoutMitigationStatus | null>(null)

  /**
   * Retry data for standalone mode: failed rows grouped by filename.
   * Set by ResultsView before navigating to /run for retry.
   * Consumed and cleared by RunView.startImport().
   */
  const retryRows = ref<Map<string, { rows: Array<{ rowNum: number; data: Record<string, string> }>; headers: string[] }> | null>(null)

  const currentFile = computed(() => {
    if (progress.value.currentFileIndex < 0) return null
    const files = Object.values(progress.value.files)
    return files[progress.value.currentFileIndex] || null
  })

  const globalProgress = computed(() => {
    const files = Object.values(progress.value.files).filter(f => !f.skipped)
    const total = files.reduce((sum, f) => sum + f.totalRows, 0)
    const processed = files.reduce((sum, f) => sum + f.processedRows, 0)
    return total > 0 ? processed / total : 0
  })

  /** Record a progress sample for ETA/throughput smoothing. */
  function recordProgressSample() {
    const p = globalProgress.value
    const now = Date.now()
    // Skip duplicate samples (no progress change)
    const last = progressSamples.value[progressSamples.value.length - 1]
    if (last && last.progress === p) return
    progressSamples.value.push({ time: now, progress: p })
    if (progressSamples.value.length > MAX_SAMPLES) {
      progressSamples.value = progressSamples.value.slice(-MAX_SAMPLES)
    }
  }

  const estimatedTimeRemaining = computed<number | null>(() => {
    if (!runStartTime.value) return null
    const p = globalProgress.value
    if (p <= 0) return null
    if (p >= 1) return 0

    const now = Date.now()
    const samples = progressSamples.value

    // Sliding window rate (recent trend)
    let windowRate = 0
    if (samples.length >= 2) {
      const first = samples[0]
      const last = samples[samples.length - 1]
      const dt = last.time - first.time
      const dp = last.progress - first.progress
      if (dt > 0 && dp > 0) windowRate = dp / dt
    }

    // Total average rate (overall)
    const elapsed = now - runStartTime.value
    const totalRate = elapsed > 0 ? p / elapsed : 0

    // Blend: prefer window rate when we have enough samples
    const rate = samples.length >= 5
      ? 0.7 * windowRate + 0.3 * totalRate
      : totalRate

    if (rate <= 0) return null

    const remaining = (1 - p) / rate
    const seconds = Math.round(remaining / 1000)
    // Cap at 24 hours
    return Math.min(seconds, 86400)
  })

  const throughput = computed<number | null>(() => {
    const samples = progressSamples.value
    if (samples.length < 2) return null

    const totalRows = Object.values(progress.value.files)
      .filter(f => !f.skipped)
      .reduce((sum, f) => sum + f.totalRows, 0)
    if (totalRows <= 0) return null

    const first = samples[Math.max(0, samples.length - 10)]
    const last = samples[samples.length - 1]
    const dt = (last.time - first.time) / 1000 // seconds
    const dp = last.progress - first.progress

    if (dt <= 0 || dp <= 0) return null
    return Math.round((dp * totalRows) / dt)
  })

  const isActive = computed(() => {
    return [
      ImportState.VALIDATING,
      ImportState.RUNNING_FILE,
      ImportState.PAUSED
    ].includes(state.value)
  })

  const isCompleted = computed(() => {
    return state.value === ImportState.COMPLETED || state.value === ImportState.FAILED
  })

  const hasRetryableErrors = computed(() => {
    return errors.value.some(e => e.rowNumber > 0)
  })

  const isWaitingForConnection = computed(() => connectionStatus.value === 'offline')

  /**
   * Stall threshold in ms, scaled by batch size.
   * Formula mirrors 16.0's per-batch timeout shape:
   *   max(90_000, BASE_MS + PER_ROW_MS * batchSize)
   * The floor is also at least 3× PROGRESS_COMMIT_INTERVAL (30 s) = 90 s,
   * so the constant 90_000 floor already satisfies both constraints.
   */
  function stallThresholdMs(batchSize: number): number {
    const BASE_MS = 30_000
    const PER_ROW_MS = 300
    return Math.max(90_000, BASE_MS + PER_ROW_MS * batchSize)
  }

  const isStalled = computed(() => {
    if (!lastHeartbeat.value) return false
    if (connectionStatus.value === 'offline') return false
    if (!isActive.value) return false
    const batchSize = 200  // conservative default; will be configurable once batchSize flows here
    const age = Date.now() - new Date(lastHeartbeat.value).getTime()
    return age > stallThresholdMs(batchSize)
  })

  function initRun(filenames: string[], rowCounts: Map<string, number>, dryRun = false) {
    isHistoricalLog.value = false
    isDryRun.value = dryRun
    connectionStatus.value = 'online'
    logId.value = null
    resumeLogId.value = null
    const files: Record<string, FileProgress> = {}
    for (const f of filenames) {
      files[f] = {
        filename: f,
        totalRows: rowCounts.get(f) || 0,
        processedRows: 0,
        successCount: 0,
        failedCount: 0,
        retryingCount: 0
      }
    }
    progress.value = {
      totalFiles: filenames.length,
      completedFiles: 0,
      currentFileIndex: -1,
      files
    }
    errors.value = []
    downloadErrors.value = []
    errorKeys.clear()
    progressSamples.value = []
    runStartTime.value = Date.now()
  }

  function startFile(filename: string) {
    const files = Object.keys(progress.value.files)
    progress.value.currentFileIndex = files.indexOf(filename)

    const fileProgress = progress.value.files[filename]
    if (fileProgress) {
      fileProgress.startTime = Date.now()
    }
  }

  function updateFileProgress(
    filename: string,
    update: Partial<Pick<FileProgress, 'processedRows' | 'successCount' | 'failedCount' | 'retryingCount'>>
  ) {
    const fileProgress = progress.value.files[filename]
    if (fileProgress) {
      Object.assign(fileProgress, update)
    }
  }

  function completeFile(filename: string) {
    const fileProgress = progress.value.files[filename]
    if (!fileProgress) return
    // Guard against double-complete (queued file_done + direct call)
    if (fileProgress.endTime) return
    fileProgress.endTime = Date.now()
    progress.value.completedFiles++
  }

  function skipFile(filename: string) {
    const fileProgress = progress.value.files[filename]
    if (!fileProgress) return
    if (fileProgress.endTime) return
    fileProgress.skipped = true
    fileProgress.endTime = Date.now()
    progress.value.completedFiles++
  }

  function addError(error: ImportRowError) {
    const key = `${error.filename}:${error.rowNumber}:${error.error.substring(0, 80)}`
    if (errorKeys.has(key)) return
    errorKeys.add(key)
    totalErrorsSeen.value++
    // Display list: cap at MAX_ERRORS with FIFO eviction — always show the
    // MOST RECENT N errors. Previously the cap discarded new errors once full,
    // so the UI froze on the first 5,000 and you couldn't see what happened
    // later in the run. The download list (downloadErrors) keeps every error.
    if (errors.value.length >= MAX_ERRORS) {
      errors.value.shift()
    }
    errors.value.push(error)
    // Download list: unbounded — always accumulates every error
    downloadErrors.value.push(error)
  }

  function setState(newState: ImportState) {
    state.value = newState
  }

  function setTimeoutMitigation(active: boolean, status: TimeoutMitigationStatus | null = null) {
    timeoutMitigationActive.value = active
    timeoutMitigationStatus.value = active ? status : null
  }

  function setHeartbeat(ts: string) {
    lastHeartbeat.value = ts
  }

  function reset() {
    state.value = ImportState.IDLE
    isDryRun.value = false
    logId.value = null
    connectionStatus.value = 'online'
    resumeLogId.value = null
    progress.value = {
      totalFiles: 0,
      completedFiles: 0,
      currentFileIndex: -1,
      files: {}
    }
    errors.value = []
    downloadErrors.value = []
    errorKeys.clear()
    totalErrorsSeen.value = 0
    lastHeartbeat.value = null
    progressSamples.value = []
    runStartTime.value = null
    isHistoricalLog.value = false
    retryRows.value = null
    timeoutMitigationActive.value = false
    timeoutMitigationStatus.value = null
    validationState.value = 'not_run'
    validationResult.value = null
  }

  /**
   * Update store from server polling response.
   * Called by RunView every 500ms during import.
   */
  function updateFromServer(data: {
    state: string
    progress: Record<string, { totalRows: number; successCount: number; failedCount: number; processedRanges?: [number, number][]; skipped?: boolean }>
    success_rows: number
    failed_rows: number
    total_rows: number
    current_file: string
    errors: Array<{ filename: string; rowNumber: number; error: string }>
    is_dry_run: boolean
    heartbeat?: string | null
    connection_status?: string | null
  }) {
    // Map server state to ImportState enum
    const stateMap: Record<string, ImportState> = {
      'draft': ImportState.IDLE,
      'pending': ImportState.VALIDATING,
      'running': ImportState.RUNNING_FILE,
      'paused': ImportState.PAUSED,
      'completed': ImportState.COMPLETED,
      'failed': ImportState.FAILED,
      'interrupted': ImportState.INTERRUPTED,
    }
    state.value = stateMap[data.state] || ImportState.RUNNING_FILE
    isDryRun.value = data.is_dry_run
    if (data.heartbeat !== undefined) {
      lastHeartbeat.value = data.heartbeat ?? null
    }
    if (data.connection_status) {
      connectionStatus.value = data.connection_status as ConnectionStatus
    }

    // Update file progress
    const filenames = Object.keys(data.progress)
    const files: Record<string, FileProgress> = {}
    for (const filename of filenames) {
      const fp = data.progress[filename]
      files[filename] = {
        filename,
        totalRows: fp.totalRows,
        processedRows: fp.successCount + fp.failedCount,
        successCount: fp.successCount,
        failedCount: fp.failedCount,
        retryingCount: 0,
        skipped: fp.skipped,
      }
    }

    const currentFileIdx = data.current_file ? filenames.indexOf(data.current_file) : -1
    const completedCount = filenames.filter(f => {
      const fp = data.progress[f]
      return fp.skipped || (fp.successCount + fp.failedCount >= fp.totalRows && fp.totalRows > 0)
    }).length

    progress.value = {
      totalFiles: filenames.length,
      completedFiles: completedCount,
      currentFileIndex: currentFileIdx >= 0 ? currentFileIdx : filenames.length - 1,
      files,
    }

    recordProgressSample()

    // Merge errors (server truncates to 100 — don't lose earlier ones)
    const now = Date.now()
    // NOTE: in addon mode, the server polling response is capped server-side
    // at MAX_POLL_ERROR_ENTRIES = 100 entries per poll (see import_job.py).
    // If more than 100 errors occur between two polls, the middle ones are
    // lost server-side and never reach this code — that's a separate concern
    // from the client-side display cap below.
    for (const e of data.errors) {
      const key = `${e.filename}:${e.rowNumber}:${e.error.substring(0, 80)}`
      if (!errorKeys.has(key)) {
        errorKeys.add(key)
        totalErrorsSeen.value++
        const newError: ImportRowError = {
          filename: e.filename,
          rowNumber: e.rowNumber,
          rawData: {},
          error: e.error,
          timestamp: now,
        }
        // FIFO eviction so the UI always shows the most recent errors.
        if (errors.value.length >= MAX_ERRORS) {
          errors.value.shift()
        }
        errors.value.push(newError)
        downloadErrors.value.push(newError)
      }
    }
  }

  async function loadFromServerLog(id: number): Promise<boolean> {
    const log = await getImportLog(id)
    if (!log) return false

    const files: Record<string, FileProgress> = {}
    const filenames = Object.keys(log.file_progress)
    for (const filename of filenames) {
      const fp = log.file_progress[filename]
      files[filename] = {
        filename,
        totalRows: fp.totalRows,
        processedRows: fp.successCount + fp.failedCount,
        successCount: fp.successCount,
        failedCount: fp.failedCount,
        retryingCount: 0,
      }
    }
    progress.value = {
      totalFiles: filenames.length,
      completedFiles: filenames.length,
      currentFileIndex: filenames.length - 1,
      files,
    }

    const loadedErrors = log.error_log.map((e: { filename: string; rowNumber: number; error: string }) => ({
      filename: e.filename,
      rowNumber: e.rowNumber,
      rawData: {},
      error: e.error,
      timestamp: 0,
    }))
    errors.value = loadedErrors
    downloadErrors.value = loadedErrors.slice()

    state.value = log.state === 'failed' ? ImportState.FAILED : ImportState.COMPLETED
    isDryRun.value = log.is_dry_run
    runStartTime.value = log.started_at ? new Date(log.started_at).getTime() : null

    if (log.started_at && log.finished_at) {
      const endEpoch = new Date(log.finished_at).getTime()
      for (const fp of Object.values(files)) {
        fp.startTime = runStartTime.value ?? undefined
        fp.endTime = endEpoch
      }
    }

    validationState.value = log.validation_state ?? 'not_run'
    validationResult.value = log.validation_result ?? null

    isHistoricalLog.value = true
    return true
  }

  return {
    state,
    isDryRun,
    logId,
    connectionStatus,
    resumeLogId,
    progress,
    errors,
    downloadErrors,
    totalErrorsSeen,
    runStartTime,
    isHistoricalLog,
    retryRows,
    currentFile,
    globalProgress,
    estimatedTimeRemaining,
    throughput,
    isActive,
    isCompleted,
    hasRetryableErrors,
    isWaitingForConnection,
    lastHeartbeat,
    isStalled,
    stallThresholdMs,
    timeoutMitigationActive,
    timeoutMitigationStatus,
    validationState,
    validationResult,
    setValidation,
    setTimeoutMitigation,
    setHeartbeat,
    initRun,
    startFile,
    updateFileProgress,
    recordProgressSample,
    completeFile,
    skipFile,
    addError,
    setState,
    reset,
    updateFromServer,
    loadFromServerLog
  }
})
