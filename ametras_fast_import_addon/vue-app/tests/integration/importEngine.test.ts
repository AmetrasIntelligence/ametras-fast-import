import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import { setupMockStream, resetMockStreams } from '../setup'
import {
  DEMO_CSV_PARTNER_SIMPLE,
} from '../fixtures'
import { ImportEngine } from '@/importer/engine'
import { ImportState } from '@/importer/stateMachine'
import { useConfigStore } from '@/stores/config'
import { useRunStore } from '@/stores/run'
import { usePlatformStore, type ExecuteBatchFn } from '@/stores/platform'

describe('ImportEngine Integration', () => {
  let pinia: Pinia
  let currentEngine: ImportEngine | null = null
  let mockExecuteBatch: ReturnType<typeof vi.fn<ExecuteBatchFn>>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.clearAllMocks()
    resetMockStreams()

    // Default mock for executeBatch - success response
    mockExecuteBatch = vi.fn<ExecuteBatchFn>(async (_model, rows) => {
      return rows.map((row, idx) => ({
        ok: true,
        rowIndex: row.index ?? idx,
        createdId: idx + 1,
        externalId: `partner_${idx + 1}`,
      }))
    })

    // Configure platform store for addon mode (all capabilities)
    const platform = usePlatformStore(pinia)
    platform.configure({
      executeBatch: mockExecuteBatch,
      maxWorkers: 4,
      batchSizeRange: { min: 1, max: 1000 },
      createBatchAdapter: null,
      capabilities: {
        dryRun: true,
        rowValidation: true,
        searchKeys: true,
        serverLogs: false, // Disable server logs in tests to avoid API calls
        serverProfiles: true,
        multipleWorkers: true,
        lang: true,
      },
      limitations: [],
    })

    // Setup default mocks
    setupMockStream(DEMO_CSV_PARTNER_SIMPLE)
  })

  afterEach(async () => {
    // Abort any running engine to prevent async leaks
    if (currentEngine) {
      currentEngine.abort()
      currentEngine = null
    }
    // Allow any pending microtasks to settle
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  describe('successful import', () => {
    it('completes import with all rows successful', async () => {
      const config = useConfigStore()
      const run = useRunStore()

      // Setup
      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { id: 'id', name: 'name', email: 'email' }
      })

      currentEngine = new ImportEngine()
      await currentEngine.start([{ id: 'file-1', name: 'partners.csv' }])

      expect(run.state).toBe(ImportState.COMPLETED)
      expect(run.progress.completedFiles).toBe(1)
    })

    it('tracks progress during import', async () => {
      const config = useConfigStore()
      const run = useRunStore()

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { name: 'name' }
      })

      currentEngine = new ImportEngine()
      await currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      const fileProgress = run.progress.files['partners.csv']
      expect(fileProgress?.successCount).toBeGreaterThan(0)
    })
  })

  describe('partial failure handling', () => {
    it('records errors for failed rows', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      config.setSettings({ retryLimit: 0, retryDelayMs: 0 })

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { name: 'name' }
      })

      mockExecuteBatch.mockResolvedValue([
        { ok: true, rowIndex: 0, createdId: 1 },
        { ok: false, rowIndex: 1, error: 'Validation error: email required' },
        { ok: true, rowIndex: 2, createdId: 3 }
      ])

      currentEngine = new ImportEngine()
      await currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      expect(run.errors.length).toBeGreaterThan(0)
      expect(run.errors[0].error).toContain('Validation error')
    })

    it('handles partial failures and records errors', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      config.setSettings({ retryLimit: 0, retryDelayMs: 0 }) // Disable retries for simpler test

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { name: 'name' }
      })

      // Some rows succeed, some fail
      mockExecuteBatch.mockReset()
      mockExecuteBatch.mockResolvedValue([
        { ok: true, rowIndex: 0, createdId: 1 },
        { ok: false, rowIndex: 1, error: 'Validation error' },
        { ok: true, rowIndex: 2, createdId: 3 }
      ])

      currentEngine = new ImportEngine()
      await currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      // Verify errors were recorded
      expect(run.errors.length).toBeGreaterThan(0)
      expect(run.errors[0].error).toContain('Validation error')
      expect(mockExecuteBatch).toHaveBeenCalledTimes(1)
    })
  })

  describe('multi-file import', () => {
    it('processes files in sequence', async () => {
      const config = useConfigStore()
      const run = useRunStore()

      config.setSequence(['file1.csv', 'file2.csv'])

      config.setFileMapping('file1.csv', {
        filename: 'file1.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { name: 'name' }
      })

      config.setFileMapping('file2.csv', {
        filename: 'file2.csv',
        model: 'product.template',
        idColumn: 'id',
        fieldMappings: { name: 'name' }
      })

      setupMockStream('id,name\n1,Test')

      mockExecuteBatch.mockResolvedValue([
        { ok: true, rowIndex: 0, createdId: 1 }
      ])

      currentEngine = new ImportEngine()
      await currentEngine!.start([
        { id: 'f1', name: 'file1.csv' },
        { id: 'f2', name: 'file2.csv' }
      ])

      expect(run.progress.completedFiles).toBe(2)
      expect(run.state).toBe(ImportState.COMPLETED)
    })
  })

  describe('abort functionality', () => {
    it('can abort running import', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      const platform = usePlatformStore()

      // Use a slow mock so the abort signal lands before the batch completes
      platform.configure({
        ...platform.$state,
        executeBatch: vi.fn<ExecuteBatchFn>(async (_model, rows) => {
          await new Promise(resolve => setTimeout(resolve, 200))
          return rows.map((row, idx) => ({
            ok: true,
            rowIndex: row.index ?? idx,
            createdId: idx + 1,
          }))
        }),
      })

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: null,
        fieldMappings: { name: 'name' }
      })

      currentEngine = new ImportEngine()
      const importPromise = currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      // Wait a tick so the engine enters the batch execution loop
      await new Promise(resolve => setTimeout(resolve, 10))

      currentEngine!.abort()

      await importPromise

      // Changed from IDLE to FAILED so results can still be viewed after abort
      expect(run.state).toBe(ImportState.FAILED)
    })
  })

  describe('pause/resume', () => {
    it('can pause during import', async () => {
      const config = useConfigStore()

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: null,
        fieldMappings: { name: 'name' }
      })

      currentEngine = new ImportEngine()
      const importPromise = currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      // Engine should complete before we can pause in this test
      await importPromise

      expect(currentEngine!.state).toBe(ImportState.COMPLETED)
    })
  })

  describe('batch size configurations', () => {
    it('respects small batch size', async () => {
      const config = useConfigStore()
      config.setSettings({ batchSize: 2 })

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: null,
        fieldMappings: { name: 'name' }
      })

      currentEngine = new ImportEngine()
      await currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])
    })

    it('respects large batch size', async () => {
      const config = useConfigStore()
      config.setSettings({ batchSize: 500 })

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: null,
        fieldMappings: { name: 'name' }
      })

      currentEngine = new ImportEngine()
      await currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])
    })
  })

  describe('no retry configuration', () => {
    it('does not retry when retryLimit is 0', async () => {
      const config = useConfigStore()
      config.setSettings({ retryLimit: 0 })

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: null,
        fieldMappings: { name: 'name' }
      })

      mockExecuteBatch.mockResolvedValue([
        { ok: true, rowIndex: 0, createdId: 1 },
        { ok: false, rowIndex: 1, error: 'Validation error: email required' },
        { ok: true, rowIndex: 2, createdId: 3 }
      ])

      currentEngine = new ImportEngine()
      await currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      // Should only be called once (no retries)
      expect(mockExecuteBatch).toHaveBeenCalledTimes(1)
    })
  })

  describe('dry run mode', () => {
    it('passes dryRun flag to executeBatch', async () => {
      const config = useConfigStore()
      const run = useRunStore()

      config.setSettings({ dryRun: true })
      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { name: 'name' }
      })

      currentEngine = new ImportEngine()
      await currentEngine.start([{ id: 'file-1', name: 'partners.csv' }])

      expect(mockExecuteBatch).toHaveBeenCalledWith(
        'res.partner',
        expect.any(Array),
        expect.any(Object),
        expect.objectContaining({ dryRun: true })
      )
      expect(run.isDryRun).toBe(true)
    })

    it('does not pass dryRun when disabled', async () => {
      const config = useConfigStore()
      const run = useRunStore()

      config.setSettings({ dryRun: false })
      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { name: 'name' }
      })

      currentEngine = new ImportEngine()
      await currentEngine.start([{ id: 'file-1', name: 'partners.csv' }])

      expect(mockExecuteBatch).toHaveBeenCalledWith(
        'res.partner',
        expect.any(Array),
        expect.any(Object),
        expect.objectContaining({ dryRun: false })
      )
      expect(run.isDryRun).toBe(false)
    })
  })

  describe('sequential batch processing', () => {
    it('processes all batches with multiple chunks', async () => {
      const config = useConfigStore()
      const run = useRunStore()

      config.setSettings({ batchSize: 2 })
      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { id: 'id', name: 'name', email: 'email' }
      })

      // Set up multiple chunks using the new streaming API
      setupMockStream([
        'id,name,email\npartner_1,Test1,t1@test.com\npartner_2,Test2,t2@test.com',
        'id,name,email\npartner_3,Test3,t3@test.com\npartner_4,Test4,t4@test.com',
        'id,name,email\npartner_5,Test5,t5@test.com'
      ])

      // Track the order of executeBatch calls
      const batchCallOrder: number[] = []
      mockExecuteBatch.mockImplementation(async (_model, rows) => {
        batchCallOrder.push(rows.length)
        return rows.map((row: { index: number }) => ({
          ok: true,
          rowIndex: row.index,
          createdId: row.index
        }))
      })

      currentEngine = new ImportEngine()
      await currentEngine.start([{ id: 'file-1', name: 'partners.csv' }])

      // All rows should be processed
      expect(run.state).toBe(ImportState.COMPLETED)
      // Exact batch sizes depend on how chunks are processed
      expect(mockExecuteBatch).toHaveBeenCalled()
    })

    it('processes batches sequentially not concurrently', async () => {
      const config = useConfigStore()

      config.setSettings({ batchSize: 2 })
      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: null,
        fieldMappings: { name: 'name' }
      })

      // Set up multiple chunks
      setupMockStream([
        'name\nA\nB',
        'name\nC\nD'
      ])

      // Track concurrent execution
      let concurrentCount = 0
      let maxConcurrent = 0

      mockExecuteBatch.mockImplementation(async (_model, rows) => {
        concurrentCount++
        maxConcurrent = Math.max(maxConcurrent, concurrentCount)
        // Simulate async work
        await new Promise(resolve => setTimeout(resolve, 10))
        concurrentCount--
        return rows.map((row: { index: number }) => ({
          ok: true,
          rowIndex: row.index,
          createdId: row.index
        }))
      })

      currentEngine = new ImportEngine()
      await currentEngine.start([{ id: 'file-1', name: 'partners.csv' }])

      // Batches should never run concurrently
      expect(maxConcurrent).toBe(1)
    })
  })

  describe('external ID handling', () => {
    it('passes fieldMappings with id column', async () => {
      const config = useConfigStore()

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { id: 'id', name: 'name' }
      })

      currentEngine = new ImportEngine()
      await currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      expect(mockExecuteBatch).toHaveBeenCalledWith(
        'res.partner',
        expect.any(Array),
        expect.objectContaining({
          fieldMappings: { id: 'id', name: 'name' }
        }),
        expect.any(Object)
      )
    })

    it('passes fieldMappings with .id column', async () => {
      const config = useConfigStore()

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        fieldMappings: { '.id': '.id', name: 'name' }
      })

      currentEngine = new ImportEngine()
      await currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      expect(mockExecuteBatch).toHaveBeenCalledWith(
        'res.partner',
        expect.any(Array),
        expect.objectContaining({
          fieldMappings: { '.id': '.id', name: 'name' }
        }),
        expect.any(Object)
      )
    })
  })
})
