import { defineStore } from 'pinia'
import { ref, computed, shallowRef } from 'vue'
import { ImportState } from '@/importer/stateMachine'
import type { ImportEngine } from '@/importer/engine'
import type { ConnectionStatus } from '@/importer/connectionMonitor'
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

export interface ImportError {
  filename: string
  rowNumber: number
  rawData: Record<string, string>
  error: string
  timestamp: number
}

export const useRunStore = defineStore('run', () => {
  const state = ref<ImportState>(ImportState.IDLE)
  const isDryRun = ref(false)
  const engine = shallowRef<ImportEngine | null>(null)
  const logId = ref<number | null>(null)
  const connectionStatus = ref<ConnectionStatus>('online')
  const resumeLogId = ref<number | null>(null)
  const progress = ref<RunProgress>({
    totalFiles: 0,
    completedFiles: 0,
    currentFileIndex: -1,
    files: {}
  })
  const errors = ref<ImportError[]>([])
  const runStartTime = ref<number | null>(null)
  const isHistoricalLog = ref(false)

  const currentFile = computed(() => {
    if (progress.value.currentFileIndex < 0) return null
    const files = Object.values(progress.value.files)
    return files[progress.value.currentFileIndex] || null
  })

  const globalProgress = computed(() => {
    const files = Object.values(progress.value.files)
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
      ImportState.RUNNING_BATCH,
      ImportState.RETRYING,
      ImportState.PAUSED
    ].includes(state.value)
  })

  const isCompleted = computed(() => {
    return state.value === ImportState.COMPLETED || state.value === ImportState.FAILED
  })

  /** Check if there are row-level errors that can potentially be retried */
  const hasRetryableErrors = computed(() => {
    // Row-level errors have rowNumber > 0 (rowNumber 0 is used for file-level errors)
    return errors.value.some(e => e.rowNumber > 0)
  })

  const isWaitingForConnection = computed(() => connectionStatus.value === 'offline')

  const pendingRows = computed(() => {
    const files = Object.values(progress.value.files)
    const total = files.reduce((sum, f) => sum + f.totalRows, 0)
    const success = files.reduce((sum, f) => sum + f.successCount, 0)
    const failed = files.reduce((sum, f) => sum + f.failedCount, 0)
    return Math.max(0, total - success - failed)
  })

  function setEngine(eng: ImportEngine | null) {
    engine.value = eng
  }

  function initRun(filenames: string[], rowCounts: Map<string, number>, dryRun = false) {
    isDryRun.value = dryRun
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
    if (fileProgress) {
      fileProgress.endTime = Date.now()
    }
    progress.value.completedFiles++
  }

  function skipFile(filename: string) {
    const fileProgress = progress.value.files[filename]
    if (fileProgress) {
      fileProgress.skipped = true
      fileProgress.endTime = Date.now()
    }
    progress.value.completedFiles++
  }

  function addError(error: ImportError) {
    errors.value.push(error)
  }

  function setState(newState: ImportState) {
    state.value = newState
  }

  function reset() {
    state.value = ImportState.IDLE
    isDryRun.value = false
    engine.value = null
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
    runStartTime.value = null
    isHistoricalLog.value = false
  }

  async function loadFromServerLog(id: number): Promise<boolean> {
    const log = await getImportLog(id)
    if (!log) return false

    // Populate file progress
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

    // Populate errors
    errors.value = log.error_log.map(e => ({
      filename: e.filename,
      rowNumber: e.rowNumber,
      rawData: {},
      error: e.error,
      timestamp: 0,
    }))

    // Set state
    state.value = log.state === 'failed' ? ImportState.FAILED : ImportState.COMPLETED
    isDryRun.value = log.is_dry_run
    runStartTime.value = log.started_at ? new Date(log.started_at).getTime() : null

    // If we have both started_at and finished_at, compute synthetic endTimes for duration display
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
    engine,
    logId,
    connectionStatus,
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
    setEngine,
    reset,
    loadFromServerLog
  }
})
