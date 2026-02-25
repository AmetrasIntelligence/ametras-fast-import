import type { RunProgress, ImportError } from '@/stores/run'
import { ImportState } from './stateMachine'
import { logger } from '@/utils/logger'

/**
 * Validate that a value is a non-null object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate that a value is an array.
 */
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/**
 * Validate persisted state structure at runtime.
 * Returns error message if invalid, null if valid.
 */
function validatePersistedState(data: unknown): string | null {
  if (!isObject(data)) {
    return 'State is not an object'
  }

  // Check version
  if (data.version !== 1) {
    return `Unsupported version: ${data.version}`
  }

  // Check state enum value
  const validStates = Object.values(ImportState)
  if (!validStates.includes(data.state as ImportState)) {
    return `Invalid state: ${data.state}`
  }

  // Check progress structure
  if (!isObject(data.progress)) {
    return 'progress is not an object'
  }
  const progress = data.progress
  if (typeof progress.totalFiles !== 'number' || progress.totalFiles < 0) {
    return 'progress.totalFiles is invalid'
  }
  if (typeof progress.completedFiles !== 'number' || progress.completedFiles < 0) {
    return 'progress.completedFiles is invalid'
  }
  if (typeof progress.currentFileIndex !== 'number' || progress.currentFileIndex < 0) {
    return 'progress.currentFileIndex is invalid'
  }
  if (!isArray(progress.files)) {
    return 'progress.files is not an array'
  }

  // Validate each file entry
  for (let i = 0; i < progress.files.length; i++) {
    const file = progress.files[i]
    if (!isObject(file)) {
      return `progress.files[${i}] is not an object`
    }
    if (typeof file.filename !== 'string') {
      return `progress.files[${i}].filename is not a string`
    }
    if (typeof file.totalRows !== 'number' || file.totalRows < 0) {
      return `progress.files[${i}].totalRows is invalid`
    }
    if (typeof file.processedRows !== 'number' || file.processedRows < 0) {
      return `progress.files[${i}].processedRows is invalid`
    }
    if (typeof file.successCount !== 'number' || file.successCount < 0) {
      return `progress.files[${i}].successCount is invalid`
    }
    if (typeof file.failedCount !== 'number' || file.failedCount < 0) {
      return `progress.files[${i}].failedCount is invalid`
    }
  }

  // Check errors array
  if (!isArray(data.errors)) {
    return 'errors is not an array'
  }

  // Validate all error entries
  for (let i = 0; i < data.errors.length; i++) {
    const error = data.errors[i]
    if (!isObject(error)) {
      return `errors[${i}] is not an object`
    }
    if (typeof error.error !== 'string') {
      return `errors[${i}].error is not a string`
    }
    if (typeof error.filename !== 'string') {
      return `errors[${i}].filename is not a string`
    }
    if (typeof error.rowNumber !== 'number') {
      return `errors[${i}].rowNumber is not a number`
    }
  }

  // Check timestamps
  if (data.runStartTime !== null && typeof data.runStartTime !== 'number') {
    return 'runStartTime is not a number or null'
  }
  if (typeof data.lastBatchIndex !== 'number') {
    return 'lastBatchIndex is not a number'
  }
  if (typeof data.timestamp !== 'number') {
    return 'timestamp is not a number'
  }

  return null
}

export interface PersistedRunState {
  version: 1
  state: ImportState
  progress: {
    totalFiles: number
    completedFiles: number
    currentFileIndex: number
    files: Array<{
      filename: string
      totalRows: number
      processedRows: number
      successCount: number
      failedCount: number
    }>
  }
  errors: ImportError[]
  runStartTime: number | null
  lastBatchIndex: number
  timestamp: number
}

const STORAGE_KEY = 'ametras_fast_import_run_state'

export async function persistRunState(
  state: ImportState,
  progress: RunProgress,
  errors: ImportError[],
  runStartTime: number | null,
  lastBatchIndex: number
): Promise<void> {
  const persisted: PersistedRunState = {
    version: 1,
    state,
    progress: {
      totalFiles: progress.totalFiles,
      completedFiles: progress.completedFiles,
      currentFileIndex: progress.currentFileIndex,
      files: Object.values(progress.files)
    },
    errors,
    runStartTime,
    lastBatchIndex,
    timestamp: Date.now()
  }

  await window.api.store.set(STORAGE_KEY, persisted)
}

export async function loadPersistedRunState(): Promise<PersistedRunState | null> {
  const stored = await window.api.store.get(STORAGE_KEY)
  if (!stored) return null

  // Validate structure before using
  const validationError = validatePersistedState(stored)
  if (validationError) {
    logger.import.warn(`[persistence] Invalid persisted state: ${validationError}`)
    await clearPersistedRunState()
    return null
  }

  const persisted = stored as PersistedRunState

  // Don't restore very old states (> 24h)
  if (Date.now() - persisted.timestamp > 24 * 60 * 60 * 1000) {
    logger.import.info('[persistence] Discarding state older than 24h')
    await clearPersistedRunState()
    return null
  }

  logger.import.info('[persistence] Loaded valid persisted state')
  return persisted
}

export async function clearPersistedRunState(): Promise<void> {
  await window.api.store.set(STORAGE_KEY, null)
}

export function canResumeRun(persisted: PersistedRunState): boolean {
  return [
    ImportState.RUNNING_FILE,
    ImportState.RUNNING_BATCH,
    ImportState.RETRYING,
    ImportState.PAUSED
  ].includes(persisted.state)
}
