import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useConfigStore } from '@/stores/config'
import { exportSettingsCSV, exportSequenceCSV, importSettingsCSV } from '@/services/csvSettingsIO'
import { mockRunSettings } from '../../fixtures'
import Papa from 'papaparse'

describe('ConfigStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('initial state', () => {
    it('has default run settings', () => {
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
    })

    it('has empty file mappings', () => {
      const store = useConfigStore()
      expect(Object.keys(store.fileMappings).length).toBe(0)
    })

    it('has empty import sequence', () => {
      const store = useConfigStore()
      expect(store.importSequence).toEqual([])
    })
  })

  describe('setSettings', () => {
    it('updates batch size', () => {
      const store = useConfigStore()
      store.setSettings({ batchSize: 50 })
      expect(store.settings.batchSize).toBe(50)
    })

    it('updates retry limit', () => {
      const store = useConfigStore()
      store.setSettings({ retryLimit: 5 })
      expect(store.settings.retryLimit).toBe(5)
    })

    it('updates encoding', () => {
      const store = useConfigStore()
      store.setSettings({ encoding: 'latin-1' })
      expect(store.settings.encoding).toBe('latin-1')
    })

    it('updates delimiter', () => {
      const store = useConfigStore()
      store.setSettings({ delimiter: ';' })
      expect(store.settings.delimiter).toBe(';')
    })

    it('updates skipHeader', () => {
      const store = useConfigStore()
      store.setSettings({ skipHeader: false })
      expect(store.settings.skipHeader).toBe(false)
    })

    it('updates dryRun', () => {
      const store = useConfigStore()
      store.setSettings({ dryRun: true })
      expect(store.settings.dryRun).toBe(true)
    })

    it('updates lang', () => {
      const store = useConfigStore()
      store.setSettings({ lang: 'en_US' })
      expect(store.settings.lang).toBe('en_US')
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
    it('sets file mapping', () => {
      const store = useConfigStore()

      store.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { name: 'name', email: 'email' }
      })

      expect('partners.csv' in store.fileMappings).toBe(true)
    })

    it('gets file mapping', () => {
      const store = useConfigStore()

      const mapping = {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id' as const,
        fieldMappings: { name: 'name' }
      }

      store.setFileMapping('partners.csv', mapping)

      expect(store.getFileMapping('partners.csv')).toEqual(mapping)
    })

    it('returns undefined for unknown file', () => {
      const store = useConfigStore()
      expect(store.getFileMapping('unknown.csv')).toBeUndefined()
    })

    it('updates existing mapping', () => {
      const store = useConfigStore()

      store.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { name: 'name' }
      })

      store.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: '.id',
        fieldMappings: { name: 'display_name' }
      })

      const mapping = store.getFileMapping('partners.csv')
      expect(mapping?.idColumn).toBe('.id')
      expect(mapping?.fieldMappings.name).toBe('display_name')
    })
  })

  describe('import sequence', () => {
    it('sets sequence', () => {
      const store = useConfigStore()
      store.setSequence(['file1.csv', 'file2.csv', 'file3.csv'])
      expect(store.importSequence).toEqual(['file1.csv', 'file2.csv', 'file3.csv'])
    })

    it('moves file up in sequence', () => {
      const store = useConfigStore()
      store.setSequence(['file1.csv', 'file2.csv', 'file3.csv'])

      store.moveInSequence('file2.csv', 'up')

      expect(store.importSequence).toEqual(['file2.csv', 'file1.csv', 'file3.csv'])
    })

    it('moves file down in sequence', () => {
      const store = useConfigStore()
      store.setSequence(['file1.csv', 'file2.csv', 'file3.csv'])

      store.moveInSequence('file2.csv', 'down')

      expect(store.importSequence).toEqual(['file1.csv', 'file3.csv', 'file2.csv'])
    })

    it('does not move first file up', () => {
      const store = useConfigStore()
      store.setSequence(['file1.csv', 'file2.csv'])

      store.moveInSequence('file1.csv', 'up')

      expect(store.importSequence).toEqual(['file1.csv', 'file2.csv'])
    })

    it('does not move last file down', () => {
      const store = useConfigStore()
      store.setSequence(['file1.csv', 'file2.csv'])

      store.moveInSequence('file2.csv', 'down')

      expect(store.importSequence).toEqual(['file1.csv', 'file2.csv'])
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

      const csv = `key,value
batchSize,50`

      importSettingsCSV(csv)

      expect(store.settings.batchSize).toBe(50)
      expect(store.settings.retryLimit).toBe(3) // unchanged default
    })
  })

  describe('different configurations', () => {
    it('applies small batch configuration', () => {
      const store = useConfigStore()
      store.setSettings(mockRunSettings.small)

      expect(store.settings.batchSize).toBe(10)
      expect(store.settings.stopOnFatalError).toBe(true)
    })

    it('applies large batch configuration', () => {
      const store = useConfigStore()
      store.setSettings(mockRunSettings.large)

      expect(store.settings.batchSize).toBe(500)
      expect(store.settings.retryLimit).toBe(5)
    })

    it('applies no-retry configuration', () => {
      const store = useConfigStore()
      store.setSettings(mockRunSettings.noRetry)

      expect(store.settings.retryLimit).toBe(0)
      expect(store.settings.retryDelayMs).toBe(0)
      expect(store.settings.encoding).toBe('latin-1')
      expect(store.settings.delimiter).toBe('\t')
      expect(store.settings.skipHeader).toBe(false)
    })

    it('applies dry run configuration', () => {
      const store = useConfigStore()
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
