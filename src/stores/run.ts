import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ImportState } from '@/importer/stateMachine'

export interface FileProgress {
  filename: string
  totalRows: number
  processedRows: number
  successCount: number
  failedCount: number
  retryingCount: number
  startTime?: number
  endTime?: number
}

export interface RunProgress {
  totalFiles: number
  completedFiles: number
  currentFileIndex: number
  files: Map<string, FileProgress>
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
  const progress = ref<RunProgress>({
    totalFiles: 0,
    completedFiles: 0,
    currentFileIndex: -1,
    files: new Map()
  })
  const errors = ref<ImportError[]>([])
  const runStartTime = ref<number | null>(null)

  const currentFile = computed(() => {
    if (progress.value.currentFileIndex < 0) return null
    const files = Array.from(progress.value.files.values())
    return files[progress.value.currentFileIndex] || null
  })

  const globalProgress = computed(() => {
    const files = Array.from(progress.value.files.values())
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

  function initRun(filenames: string[], rowCounts: Map<string, number>, dryRun = false) {
    isDryRun.value = dryRun
    progress.value = {
      totalFiles: filenames.length,
      completedFiles: 0,
      currentFileIndex: -1,
      files: new Map(
        filenames.map(f => [f, {
          filename: f,
          totalRows: rowCounts.get(f) || 0,
          processedRows: 0,
          successCount: 0,
          failedCount: 0,
          retryingCount: 0
        }])
      )
    }
    errors.value = []
    runStartTime.value = Date.now()
  }

  function startFile(filename: string) {
    const files = Array.from(progress.value.files.keys())
    progress.value.currentFileIndex = files.indexOf(filename)

    const fileProgress = progress.value.files.get(filename)
    if (fileProgress) {
      fileProgress.startTime = Date.now()
    }
  }

  function updateFileProgress(
    filename: string,
    update: Partial<Pick<FileProgress, 'processedRows' | 'successCount' | 'failedCount' | 'retryingCount'>>
  ) {
    const fileProgress = progress.value.files.get(filename)
    if (fileProgress) {
      Object.assign(fileProgress, update)
    }
  }

  function completeFile(filename: string) {
    const fileProgress = progress.value.files.get(filename)
    if (fileProgress) {
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
    progress.value = {
      totalFiles: 0,
      completedFiles: 0,
      currentFileIndex: -1,
      files: new Map()
    }
    errors.value = []
    runStartTime.value = null
  }

  return {
    state,
    isDryRun,
    progress,
    errors,
    runStartTime,
    currentFile,
    globalProgress,
    estimatedTimeRemaining,
    initRun,
    startFile,
    updateFileProgress,
    completeFile,
    addError,
    setState,
    reset
  }
})
