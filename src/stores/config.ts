import { defineStore } from 'pinia'
import { ref } from 'vue'
import { DEFAULT_RUN_SETTINGS } from '@/constants/defaults'

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

export const useConfigStore = defineStore('config', () => {
  const settings = ref<RunSettings>({ ...DEFAULT_RUN_SETTINGS })

  const fileMappings = ref<Map<string, FileMapping>>(new Map())
  const importSequence = ref<string[]>([])

  function setSettings(newSettings: Partial<RunSettings>) {
    settings.value = { ...settings.value, ...newSettings }
  }

  function setFileMapping(filename: string, mapping: FileMapping) {
    // Create new Map to ensure Vue reactivity triggers
    const newMap = new Map(fileMappings.value)
    newMap.set(filename, mapping)
    fileMappings.value = newMap
  }

  function getFileMapping(filename: string): FileMapping | undefined {
    return fileMappings.value.get(filename)
  }

  function removeFileMapping(filename: string) {
    if (fileMappings.value.has(filename)) {
      const newMap = new Map(fileMappings.value)
      newMap.delete(filename)
      fileMappings.value = newMap
    }
  }

  function clearFileMappings() {
    fileMappings.value = new Map()
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

  function exportSettingsCSV(): string {
    const lines = ['key,value']
    for (const [key, value] of Object.entries(settings.value)) {
      lines.push(`${key},${value}`)
    }
    return lines.join('\n')
  }

  function exportSequenceCSV(): string {
    const lines = ['order,filename']
    importSequence.value.forEach((filename, idx) => {
      lines.push(`${idx + 1},${filename}`)
    })
    return lines.join('\n')
  }

  function importSettingsCSV(csv: string) {
    const lines = csv.trim().split('\n').slice(1)
    const newSettings: Partial<RunSettings> = {}

    for (const line of lines) {
      const [key, value] = line.split(',')
      if (key === 'batchSize') newSettings.batchSize = parseInt(value, 10)
      if (key === 'retryLimit') newSettings.retryLimit = parseInt(value, 10)
      if (key === 'retryDelayMs') newSettings.retryDelayMs = parseInt(value, 10)
      if (key === 'stopOnFatalError') newSettings.stopOnFatalError = value === 'true'
      if (key === 'encoding') newSettings.encoding = value as RunSettings['encoding']
      if (key === 'delimiter') newSettings.delimiter = value as RunSettings['delimiter']
      if (key === 'skipHeader') newSettings.skipHeader = value === 'true'
      if (key === 'dryRun') newSettings.dryRun = value === 'true'
      if (key === 'lang') newSettings.lang = value
      if (key === 'strict') newSettings.strict = value === 'true'
      // Note: 'workers' is intentionally NOT loaded from CSV - it's a runtime-only setting
    }

    setSettings(newSettings)
  }

  return {
    settings,
    fileMappings,
    importSequence,
    setSettings,
    setFileMapping,
    getFileMapping,
    removeFileMapping,
    clearFileMappings,
    setSequence,
    moveInSequence,
    exportSettingsCSV,
    exportSequenceCSV,
    importSettingsCSV
  }
})
