import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useConfigStore, type RunSettings } from '@/stores/config'
import { mockRunSettings } from '../../fixtures'
import Papa from 'papaparse'

// Inlined from deleted services/csvSettingsIO.ts — only used by this test file
function exportSettingsCSV(): string {
  const config = useConfigStore()
  const rows = Object.entries(config.settings).map(([key, value]) => ({
    key,
    value: String(value)
  }))
  return Papa.unparse(rows, { columns: ['key', 'value'], header: true })
}

function exportSequenceCSV(): string {
  const config = useConfigStore()
  const lines = ['order,filename']
  config.importSequence.forEach((filename, idx) => {
    lines.push(`${idx + 1},${filename}`)
  })
  return lines.join('\n')
}

function importSettingsCSV(csv: string) {
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
  }
  config.setSettings(newSettings)
}

describe('ConfigStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('initial state', () => {
    it('has correct defaults', () => {
      const store = useConfigStore()

      expect(store.settings.batchSize).toBe(200)
      expect(store.settings.retryLimit).toBe(3)
      expect(store.settings.retryDelayMs).toBe(500)
      expect(store.settings.stopOnFatalError).toBe(false)
      expect(store.settings.encoding).toBe('utf-8-sig')
      expect(store.settings.delimiter).toBe(',')
      expect(store.settings.skipHeader).toBe(true)
      expect(store.settings.dryRun).toBe(false)
      expect(store.settings.lang).toBe('de_DE')
      expect(Object.keys(store.fileMappings).length).toBe(0)
      expect(store.importSequence).toEqual([])
    })
  })

  describe('setSettings', () => {
    it('updates individual settings', () => {
      const store = useConfigStore()
      const cases: [Partial<RunSettings>, keyof RunSettings, unknown][] = [
        [{ batchSize: 50 }, 'batchSize', 50],
        [{ retryLimit: 5 }, 'retryLimit', 5],
        [{ encoding: 'latin-1' }, 'encoding', 'latin-1'],
        [{ delimiter: ';' }, 'delimiter', ';'],
        [{ skipHeader: false }, 'skipHeader', false],
        [{ dryRun: true }, 'dryRun', true],
        [{ lang: 'en_US' }, 'lang', 'en_US'],
      ]
      for (const [update, key, expected] of cases) {
        store.setSettings(update)
        expect(store.settings[key]).toBe(expected)
      }
    })

    it('updates multiple settings at once', () => {
      const store = useConfigStore()
      store.setSettings(mockRunSettings.small)

      expect(store.settings.batchSize).toBe(10)
      expect(store.settings.retryLimit).toBe(1)
      expect(store.settings.retryDelayMs).toBe(500)
      expect(store.settings.stopOnFatalError).toBe(true)
      expect(store.settings.encoding).toBe('utf-8')
      expect(store.settings.delimiter).toBe(';')
      expect(store.settings.lang).toBe('en_US')
    })

    it('preserves unspecified settings', () => {
      const store = useConfigStore()
      const originalRetryDelay = store.settings.retryDelayMs
      store.setSettings({ batchSize: 200 })
      expect(store.settings.retryDelayMs).toBe(originalRetryDelay)
    })
  })

  describe('file mappings', () => {
    it('sets, gets, updates, and handles unknown files', () => {
      const store = useConfigStore()

      store.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { name: 'name', email: 'email' }
      })
      expect('partners.csv' in store.fileMappings).toBe(true)

      const mapping = {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id' as const,
        fieldMappings: { name: 'name' }
      }
      store.setFileMapping('partners.csv', mapping)
      expect(store.getFileMapping('partners.csv')).toEqual(mapping)

      expect(store.getFileMapping('unknown.csv')).toBeUndefined()

      store.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: '.id',
        fieldMappings: { name: 'display_name' }
      })
      const updated = store.getFileMapping('partners.csv')
      expect(updated?.idColumn).toBe('.id')
      expect(updated?.fieldMappings.name).toBe('display_name')
    })
  })

  describe('import sequence', () => {
    it('sets sequence', () => {
      const store = useConfigStore()
      store.setSequence(['file1.csv', 'file2.csv', 'file3.csv'])
      expect(store.importSequence).toEqual(['file1.csv', 'file2.csv', 'file3.csv'])
    })

    it('moves files in sequence', () => {
      const cases: [string, 'up' | 'down', string[]][] = [
        ['file2.csv', 'up', ['file2.csv', 'file1.csv', 'file3.csv']],
        ['file2.csv', 'down', ['file1.csv', 'file3.csv', 'file2.csv']],
        ['file1.csv', 'up', ['file1.csv', 'file2.csv', 'file3.csv']],
        ['file3.csv', 'down', ['file1.csv', 'file2.csv', 'file3.csv']],
      ]
      for (const [file, direction, expected] of cases) {
        const store = useConfigStore()
        store.setSequence(['file1.csv', 'file2.csv', 'file3.csv'])
        store.moveInSequence(file, direction)
        expect(store.importSequence).toEqual(expected)
      }
    })

    it('ignores unknown file', () => {
      const store = useConfigStore()
      store.setSequence(['file1.csv', 'file2.csv'])
      store.moveInSequence('unknown.csv', 'up')
      expect(store.importSequence).toEqual(['file1.csv', 'file2.csv'])
    })
  })

  describe('CSV export', () => {
    it('exports settings as CSV', () => {
      const store = useConfigStore()
      store.setSettings({ batchSize: 50, retryLimit: 2 })

      const csv = exportSettingsCSV()
      const parsed = Papa.parse<{ key?: string; value?: string }>(csv, {
        header: true,
        skipEmptyLines: true
      })
      const map = Object.fromEntries(
        parsed.data
          .filter(row => row.key)
          .map(row => [row.key as string, row.value as string])
      )

      expect(map.batchSize).toBe('50')
      expect(map.retryLimit).toBe('2')
      expect(map.encoding).toBe('utf-8-sig')
      expect(map.delimiter).toBe(',')
      expect(map.skipHeader).toBe('true')
      expect(map.dryRun).toBe('false')
      expect(map.lang).toBe('de_DE')
    })

    it('exports sequence as CSV', () => {
      const store = useConfigStore()
      store.setSequence(['first.csv', 'second.csv', 'third.csv'])

      const csv = exportSequenceCSV()

      expect(csv).toContain('order,filename')
      expect(csv).toContain('1,first.csv')
      expect(csv).toContain('2,second.csv')
      expect(csv).toContain('3,third.csv')
    })
  })

  describe('CSV import', () => {
    it('imports settings from CSV', () => {
      const store = useConfigStore()

      const csv = `key,value
batchSize,300
retryLimit,5
retryDelayMs,3000
stopOnFatalError,true
encoding,latin-1
delimiter,;
skipHeader,false
dryRun,true
lang,en_US`

      importSettingsCSV(csv)

      expect(store.settings.batchSize).toBe(300)
      expect(store.settings.retryLimit).toBe(5)
      expect(store.settings.retryDelayMs).toBe(3000)
      expect(store.settings.stopOnFatalError).toBe(true)
      expect(store.settings.encoding).toBe('latin-1')
      expect(store.settings.delimiter).toBe(';')
      expect(store.settings.skipHeader).toBe(false)
      expect(store.settings.dryRun).toBe(true)
      expect(store.settings.lang).toBe('en_US')
    })

    it('handles partial settings import', () => {
      const store = useConfigStore()

      importSettingsCSV(`key,value\nbatchSize,50`)

      expect(store.settings.batchSize).toBe(50)
      expect(store.settings.retryLimit).toBe(3) // unchanged default
    })
  })

  describe('different configurations', () => {
    it('applies all configuration presets', () => {
      const store = useConfigStore()

      store.setSettings(mockRunSettings.small)
      expect(store.settings.batchSize).toBe(10)
      expect(store.settings.stopOnFatalError).toBe(true)

      store.setSettings(mockRunSettings.large)
      expect(store.settings.batchSize).toBe(500)
      expect(store.settings.retryLimit).toBe(5)

      store.setSettings(mockRunSettings.noRetry)
      expect(store.settings.retryLimit).toBe(0)
      expect(store.settings.retryDelayMs).toBe(0)
      expect(store.settings.encoding).toBe('latin-1')
      expect(store.settings.delimiter).toBe('\t')
      expect(store.settings.skipHeader).toBe(false)

      store.setSettings(mockRunSettings.dryRun)
      expect(store.settings.dryRun).toBe(true)
      expect(store.settings.batchSize).toBe(200)
    })
  })

  describe('settings CSV roundtrip', () => {
    it('roundtrips all settings through CSV export/import', () => {
      const store = useConfigStore()
      store.setSettings({
        batchSize: 150,
        retryLimit: 4,
        retryDelayMs: 1500,
        stopOnFatalError: true,
        encoding: 'cp1252',
        delimiter: ';',
        skipHeader: false,
        dryRun: true,
        lang: 'fr_FR'
      })

      const csv = exportSettingsCSV()
      store.setSettings(mockRunSettings.default) // reset
      importSettingsCSV(csv)

      expect(store.settings.batchSize).toBe(150)
      expect(store.settings.retryLimit).toBe(4)
      expect(store.settings.retryDelayMs).toBe(1500)
      expect(store.settings.stopOnFatalError).toBe(true)
      expect(store.settings.encoding).toBe('cp1252')
      expect(store.settings.delimiter).toBe(';')
      expect(store.settings.skipHeader).toBe(false)
      expect(store.settings.dryRun).toBe(true)
      expect(store.settings.lang).toBe('fr_FR')
    })
  })
})
