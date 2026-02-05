import type { RunProgress, ImportError } from '@/stores/run'
import { ImportState } from './stateMachine'

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

const STORAGE_KEY = 'csv_import_run_state'

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
      files: Array.from(progress.files.values())
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

  const persisted = stored as PersistedRunState
  if (persisted.version !== 1) return null

  // Don't restore very old states (> 24h)
  if (Date.now() - persisted.timestamp > 24 * 60 * 60 * 1000) {
    await clearPersistedRunState()
    return null
  }

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
