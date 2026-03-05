import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface RunSettings {
  batchSize: number
  retryLimit: number
  retryDelayMs: number
  stopOnFatalError: boolean
  encoding: 'utf-8' | 'utf-8-sig' | 'latin-1' | 'cp1252'
  delimiter: ',' | ';' | '\t' | ''
  skipHeader: boolean
  dryRun: boolean
  lang: string
  /** Number of parallel workers for batch processing (1-4). Default: 1 */
  workers: number
  /** Strict mode: fail on unresolved references instead of skipping. Default: true */
  strict: boolean
}

export interface FileMapping {
  filename: string
  model: string
  fieldMappings: Record<string, string>
  /** Field names for natural key search (Strategy 2) */
  searchKeys?: string[]
  /** If true, fail on missing keys instead of falling back to create */
  strict?: boolean
}

/**
 * Default run settings used across the application.
 * Single source of truth for initial configuration values.
 */
export const DEFAULT_RUN_SETTINGS: RunSettings = {
  batchSize: 200,
  retryLimit: 3,
  retryDelayMs: 500,
  stopOnFatalError: false,
  encoding: 'utf-8-sig',
  delimiter: ',',
  skipHeader: true,
  dryRun: false,
  lang: 'de_DE',
  workers: 3,
  strict: true
}

export const useConfigStore = defineStore('config', () => {
  const settings = ref<RunSettings>({ ...DEFAULT_RUN_SETTINGS })

  const fileMappings = ref<Record<string, FileMapping>>({})
  const importSequence = ref<string[]>([])

  /** Persists the active profile ID across view navigation */
  const activeProfileId = ref<number | null>(null)

  function setActiveProfileId(id: number | null) {
    activeProfileId.value = id
  }

  function setSettings(newSettings: Partial<RunSettings>) {
    settings.value = { ...settings.value, ...newSettings }
  }

  function setFileMapping(filename: string, mapping: FileMapping) {
    fileMappings.value = { ...fileMappings.value, [filename]: mapping }
  }

  function getFileMapping(filename: string): FileMapping | undefined {
    return fileMappings.value[filename]
  }

  function removeFileMapping(filename: string) {
    if (filename in fileMappings.value) {
      const { [filename]: _, ...rest } = fileMappings.value
      fileMappings.value = rest
    }
  }

  function clearFileMappings() {
    fileMappings.value = {}
  }

  function setSequence(filenames: string[]) {
    importSequence.value = filenames
  }

  function moveInSequence(filename: string, direction: 'up' | 'down') {
    const idx = importSequence.value.indexOf(filename)
    if (idx === -1) return

    const newIdx = direction === 'up' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= importSequence.value.length) return

    const arr = [...importSequence.value]
    ;[arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]]
    importSequence.value = arr
  }

  return {
    settings,
    fileMappings,
    importSequence,
    activeProfileId,
    setActiveProfileId,
    setSettings,
    setFileMapping,
    getFileMapping,
    removeFileMapping,
    clearFileMappings,
    setSequence,
    moveInSequence
  }
})
