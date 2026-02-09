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
}

export interface FileMapping {
  filename: string
  model: string
  /** @deprecated ID column is now detected from fieldMappings (id→id or .id→.id) */
  idColumn?: 'id' | '.id' | null
  fieldMappings: Record<string, string>
}

export const useConfigStore = defineStore('config', () => {
  const settings = ref<RunSettings>({
    batchSize: 200,
    retryLimit: 3,
    retryDelayMs: 2000,
    stopOnFatalError: false,
    encoding: 'utf-8-sig',
    delimiter: ',',
    skipHeader: true,
    dryRun: false,
    lang: 'de_DE'
  })

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

  function exportMappingsCSV(): string {
    const lines = ['filename,model,idColumn']
    for (const [filename, mapping] of fileMappings.value) {
      lines.push(`${filename},${mapping.model},${mapping.idColumn || ''}`)
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
    exportMappingsCSV,
    exportSequenceCSV,
    importSettingsCSV
  }
})
