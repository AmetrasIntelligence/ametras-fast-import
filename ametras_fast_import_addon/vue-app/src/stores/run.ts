import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ImportState, type ConnectionStatus } from '@/importer/types'
import { getImportLog } from '@/api/odooClient'

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
  mode: 'standalone' | 'addon'
  currentBatchSize: number
  timeoutEscalationLevel: number
  retriesAtMinimumBatch: number
  nextRetryDelayMs: number
  elapsedMs: number
  budgetMs: number
}

export const useRunStore = defineStore('run', () => {
  const state = ref<ImportState>(ImportState.IDLE)
  const isDryRun = ref(false)
  const logId = ref<number | null>(null)
  const connectionStatus = ref<ConnectionStatus>('online')
  const timeoutMitigationActive = ref(false)
  const timeoutMitigationStatus = ref<TimeoutMitigationStatus | null>(null)
  const resumeLogId = ref<number | null>(null)

  const progress = ref<RunProgress>({
    totalFiles: 0,
    completedFiles: 0,
    currentFileIndex: -1,
    files: {}
  })
  const errors = ref<ImportRowError[]>([])
  const runStartTime = ref<number | null>(null)
  const isHistoricalLog = ref(false)

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

  const estimatedTimeRemaining = computed(() => {
    if (!runStartTime.value || globalProgress.value === 0) return null

    const elapsed = Date.now() - runStartTime.value
    const rate = globalProgress.value / elapsed
    const remaining = (1 - globalProgress.value) / rate

    return Math.round(remaining / 1000)
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

  const pendingRows = computed(() => {
    const files = Object.values(progress.value.files).filter(f => !f.skipped)
    const total = files.reduce((sum, f) => sum + f.totalRows, 0)
    const success = files.reduce((sum, f) => sum + f.successCount, 0)
    const failed = files.reduce((sum, f) => sum + f.failedCount, 0)
    return Math.max(0, total - success - failed)
  })

  function initRun(filenames: string[], rowCounts: Map<string, number>, dryRun = false) {
    isHistoricalLog.value = false
    isDryRun.value = dryRun
    connectionStatus.value = 'online'
    timeoutMitigationActive.value = false
    timeoutMitigationStatus.value = null
    isInitiating.value = false
    isPausing.value = false
    isSkipping.value = false
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
    errors.value.push(error)
  }

  function setState(newState: ImportState) {
    state.value = newState
  }

  function setTimeoutMitigationActive(active: boolean) {
    timeoutMitigationActive.value = active
    if (!active) {
      timeoutMitigationStatus.value = null
    }
  }

  function updateTimeoutMitigationStatus(status: TimeoutMitigationStatus) {
    timeoutMitigationStatus.value = status
    timeoutMitigationActive.value = true
  }

  function reset() {
    state.value = ImportState.IDLE
    isDryRun.value = false
    logId.value = null
    connectionStatus.value = 'online'
    timeoutMitigationActive.value = false
    timeoutMitigationStatus.value = null
    resumeLogId.value = null
    progress.value = {
      totalFiles: 0,
      completedFiles: 0,
      currentFileIndex: -1,
      files: {}
    }
    errors.value = []
    runStartTime.value = null
    isHistoricalLog.value = false
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

    // Update errors
    errors.value = data.errors.map(e => ({
      filename: e.filename,
      rowNumber: e.rowNumber,
      rawData: {},
      error: e.error,
      timestamp: 0,
    }))
  }

  async function loadFromServerLog(id: number): Promise<boolean> {
    const log = await getImportLog(id)
    if (!log) return false
    timeoutMitigationActive.value = false
    timeoutMitigationStatus.value = null

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

    errors.value = log.error_log.map((e: { filename: string; rowNumber: number; error: string }) => ({
      filename: e.filename,
      rowNumber: e.rowNumber,
      rawData: {},
      error: e.error,
      timestamp: 0,
    }))

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

    isHistoricalLog.value = true
    return true
  }

  return {
    state,
    isDryRun,
    logId,
    connectionStatus,
    timeoutMitigationActive,
    timeoutMitigationStatus,
    resumeLogId,
    progress,
    errors,
    runStartTime,
    isHistoricalLog,
    currentFile,
    globalProgress,
    estimatedTimeRemaining,
    isActive,
    isCompleted,
    hasRetryableErrors,
    isWaitingForConnection,
    pendingRows,
    initRun,
    startFile,
    updateFileProgress,
    completeFile,
    skipFile,
    addError,
    setState,
    reset,
    updateFromServer,
    loadFromServerLog
  }
})
