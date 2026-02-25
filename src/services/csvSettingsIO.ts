import Papa from 'papaparse'
import { useConfigStore, type RunSettings } from '@/stores/config'

/**
 * Export current run settings as CSV.
 */
export function exportSettingsCSV(): string {
  const config = useConfigStore()
  const rows = Object.entries(config.settings).map(([key, value]) => ({
    key,
    value: String(value)
  }))
  return Papa.unparse(rows, { columns: ['key', 'value'], header: true })
}

/**
 * Export current import sequence as CSV.
 */
export function exportSequenceCSV(): string {
  const config = useConfigStore()
  const lines = ['order,filename']
  config.importSequence.forEach((filename, idx) => {
    lines.push(`${idx + 1},${filename}`)
  })
  return lines.join('\n')
}

/**
 * Import run settings from CSV string.
 */
export function importSettingsCSV(csv: string) {
  const config = useConfigStore()

  const parsed = Papa.parse<{ key?: string; value?: string }>(csv, {
    header: true,
    skipEmptyLines: true
  })
  const newSettings: Partial<RunSettings> = {}

  for (const row of parsed.data) {
    const key = row.key || ''
    const value = row.value || ''
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

  config.setSettings(newSettings)
}
