import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockApi } from '../setup'
import { useFileManagement } from '@/composables/useFileManagement'
import { useFieldMetadata } from '@/composables/useFieldMetadata'
import { useFilesStore } from '@/stores/files'
import { useConfigStore } from '@/stores/config'

// The composable calls useI18n() for warning messages.
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k }),
  createI18n: vi.fn(),
}))

function makeFm() {
  return useFileManagement(useFieldMetadata())
}

/**
 * Integration test of the real file-select → analyze → status orchestration.
 * Only the IPC layer (window.api) is mocked; the analysis (PapaParse), status
 * transitions, store wiring and config population all run for real.
 */
describe('useFileManagement — upload & analysis orchestration', () => {
  beforeEach(() => {
    delete (mockApi as unknown as { python?: unknown }).python
    mockApi.files.select.mockReset().mockResolvedValue([])
    mockApi.files.readHead.mockReset().mockResolvedValue('')
    mockApi.files.countLines.mockReset().mockResolvedValue(0)
    mockApi.odoo.call.mockReset().mockResolvedValue({})
  })

  it('adds a file, analyzes it, and marks it ready', async () => {
    mockApi.files.select.mockResolvedValue([{ id: 'f1', name: 'contacts.csv', size: 10 }])
    mockApi.files.readHead.mockResolvedValue('name,email\nAcme,a@b.co\nGlobex,g@x.co\n')
    mockApi.files.countLines.mockResolvedValue(3)

    const files = useFilesStore()
    const config = useConfigStore()
    await makeFm().selectFiles()

    expect(files.files.map(f => f.name)).toEqual(['contacts.csv'])
    expect(files.getStatus('f1')?.status).toBe('ready')
    const analysis = files.getAnalysis('f1')
    expect(analysis?.headers).toEqual(['name', 'email'])
    expect(analysis?.rowCount).toBe(2) // countLines(3) - header
    expect(config.importSequence).toEqual(['contacts.csv'])
    expect(config.getFileMapping('contacts.csv')).toBeTruthy()
  })

  it('marks a file that cannot be analyzed as error', async () => {
    mockApi.files.select.mockResolvedValue([{ id: 'bad', name: 'broken.csv', size: 1 }])
    // readHead empty + countLines 0 + odoo.call has no usable analysis result.
    const files = useFilesStore()
    await makeFm().selectFiles()

    expect(files.getStatus('bad')?.status).toBe('error')
    expect(files.getAnalysis('bad')?.headers).toEqual([])
  })

  it('drops a duplicate filename', async () => {
    mockApi.files.select.mockResolvedValue([
      { id: 'a', name: 'dupe.csv', size: 1 },
      { id: 'b', name: 'dupe.csv', size: 1 },
    ])
    mockApi.files.readHead.mockResolvedValue('h\n1\n')
    mockApi.files.countLines.mockResolvedValue(2)

    const files = useFilesStore()
    await makeFm().selectFiles()
    expect(files.files).toHaveLength(1)
    expect(files.files[0].id).toBe('a')
  })

  it('drives uploading → ready via the embedded progress callbacks', async () => {
    mockApi.files.select.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (progress?: any) => {
        progress?.onStaged?.([{ name: 'p.csv', size: 1 }])
        progress?.onUploaded?.({ id: 'p1', name: 'p.csv', size: 1 })
        return [{ id: 'p1', name: 'p.csv', size: 1 }]
      },
    )
    mockApi.files.readHead.mockResolvedValue('name\nAcme\n')
    mockApi.files.countLines.mockResolvedValue(2)

    const files = useFilesStore()
    await makeFm().selectFiles()

    // The staging placeholder was replaced by the real handle, now ready.
    expect(files.files.map(f => f.id)).toEqual(['p1'])
    expect(files.getStatus('p1')?.status).toBe('ready')
    expect(files.getStatus('staging:p.csv')).toBeUndefined()
  })

  it('removeFile clears the file, its analysis/status, mapping and sequence', async () => {
    mockApi.files.select.mockResolvedValue([{ id: 'f1', name: 'contacts.csv', size: 10 }])
    mockApi.files.readHead.mockResolvedValue('name\nA\n')
    mockApi.files.countLines.mockResolvedValue(2)

    const files = useFilesStore()
    const config = useConfigStore()
    const fm = makeFm()
    await fm.selectFiles()
    expect(files.files).toHaveLength(1)

    fm.removeFile('f1')
    expect(files.files).toEqual([])
    expect(files.getStatus('f1')).toBeUndefined()
    expect(files.getAnalysis('f1')).toBeUndefined()
    expect(config.importSequence).toEqual([])
    expect(config.getFileMapping('contacts.csv')).toBeFalsy()
  })

  it('handleReorder updates the import sequence', () => {
    const config = useConfigStore()
    makeFm().handleReorder(['b.csv', 'a.csv'])
    expect(config.importSequence).toEqual(['b.csv', 'a.csv'])
  })

  it('analyzes files sequentially (standalone Python has a single command slot)', async () => {
    // Regression: concurrent analyze calls deadlock the persistent Python
    // subprocess — it must be one at a time.
    let active = 0
    let maxActive = 0
    const analyze = vi.fn().mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active -= 1
      return {
        ok: true,
        result: { type: 'analysis', headers: ['a'], rowCount: 1, sampleRows: [], delimiter: ',' },
      }
    })
    ;(mockApi as unknown as { python: { analyze: typeof analyze } }).python = { analyze }
    mockApi.files.select.mockResolvedValue([
      { id: '1', name: 'a.csv', size: 1 },
      { id: '2', name: 'b.csv', size: 1 },
      { id: '3', name: 'c.csv', size: 1 },
    ])

    const files = useFilesStore()
    await makeFm().selectFiles()

    expect(analyze).toHaveBeenCalledTimes(3)
    expect(maxActive).toBe(1) // never more than one analysis in flight
    expect(files.files.every((f) => files.getStatus(f.id)?.status === 'ready')).toBe(true)
  })
})
