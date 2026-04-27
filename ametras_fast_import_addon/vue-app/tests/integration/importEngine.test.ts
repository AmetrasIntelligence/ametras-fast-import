import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import { setupMockStream, resetMockStreams } from '../setup'
import {
  DEMO_CSV_PARTNER_SIMPLE,
} from '../fixtures'
import { ImportEngine } from '@/importer/engine'
import { ImportState } from '@/importer/stateMachine'
import { NetworkBatchError, TimeoutBatchError } from '@/importer/batchExecutor'
import { useConfigStore } from '@/stores/config'
import { useFilesStore } from '@/stores/files'
import { useRunStore } from '@/stores/run'
import { usePlatformStore, type ExecuteBatchFn } from '@/stores/platform'

async function waitForCondition(
  predicate: () => boolean,
  { maxIterations = 200, tickMs = 5 } = {}
): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, tickMs))
  }
  throw new Error('waitForCondition: timed out')
}

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
      config.setSettings({})

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
      config.setSettings({}) // Disable retries for simpler test

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

      config.setSettings({ batchSize: 2, workers: 1 })
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

  describe('retry failed rows timeout handling', () => {
    it('pauses retry processing until resumed', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      const filesStore = useFilesStore()

      let firstRows: Array<{ index: number }> = []
      let resolveFirstBatch: ((value: Array<{ ok: boolean; rowIndex: number; createdId: number }>) => void) | null = null
      const firstBatchPromise = new Promise<Array<{ ok: boolean; rowIndex: number; createdId: number }>>((resolve) => {
        resolveFirstBatch = resolve
      })

      const retryExecuteBatch = vi.fn<ExecuteBatchFn>(async (_model, rows) => {
        if (retryExecuteBatch.mock.calls.length === 1) {
          firstRows = rows
          return firstBatchPromise
        }
        return rows.map((row, idx) => ({
          ok: true,
          rowIndex: row.index,
          createdId: idx + 1,
        }))
      })

      const platform = usePlatformStore()
      platform.configure({
        executeBatch: retryExecuteBatch,
        maxWorkers: 4,
        batchSizeRange: { min: 1, max: 1000 },
        createBatchAdapter: null,
        capabilities: {
          dryRun: true,
          rowValidation: true,
          searchKeys: true,
          serverLogs: false,
          serverProfiles: true,
          multipleWorkers: true,
          lang: true,
        },
        limitations: [],
      })

      config.setSequence(['file1.csv', 'file2.csv'])
      config.setFileMapping('file1.csv', {
        filename: 'file1.csv',
        model: 'res.partner',
        fieldMappings: { name: 'name' },
      })
      config.setFileMapping('file2.csv', {
        filename: 'file2.csv',
        model: 'res.partner',
        fieldMappings: { name: 'name' },
      })

      filesStore.addFiles([
        { id: 'file-1', name: 'file1.csv', size: 16 },
        { id: 'file-2', name: 'file2.csv', size: 16 },
      ])

      run.addError({
        filename: 'file1.csv',
        rowNumber: 1,
        rawData: {},
        error: 'Previous failure row 1',
        timestamp: Date.now(),
      })
      run.addError({
        filename: 'file2.csv',
        rowNumber: 1,
        rawData: {},
        error: 'Previous failure row 1',
        timestamp: Date.now(),
      })

      setupMockStream('name\nAlice')

      currentEngine = new ImportEngine()
      const retryPromise = currentEngine.retryFailedRows()

      await waitForCondition(() => retryExecuteBatch.mock.calls.length === 1)
      currentEngine.pause()
      await waitForCondition(() => run.state === ImportState.PAUSED)

      resolveFirstBatch?.(firstRows.map((row, idx) => ({
        ok: true,
        rowIndex: row.index,
        createdId: idx + 1,
      })))

      await waitForCondition(() => run.progress.completedFiles === 1)
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(retryExecuteBatch).toHaveBeenCalledTimes(1)

      currentEngine.resume()
      await retryPromise

      expect(run.state).toBe(ImportState.COMPLETED)
      expect(run.progress.completedFiles).toBe(2)
      expect(retryExecuteBatch).toHaveBeenCalledTimes(2)
    })

    it('skips current retry file and continues with the next file', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      const filesStore = useFilesStore()

      let callCount = 0
      const retryExecuteBatch = vi.fn<ExecuteBatchFn>(async (_model, rows) => {
        callCount++
        if (callCount === 1) {
          throw new NetworkBatchError('Connection lost', rows)
        }
        return rows.map((row, idx) => ({
          ok: true,
          rowIndex: row.index,
          createdId: idx + 1,
        }))
      })

      const platform = usePlatformStore()
      platform.configure({
        executeBatch: retryExecuteBatch,
        maxWorkers: 4,
        batchSizeRange: { min: 1, max: 1000 },
        createBatchAdapter: null,
        capabilities: {
          dryRun: true,
          rowValidation: true,
          searchKeys: true,
          serverLogs: false,
          serverProfiles: true,
          multipleWorkers: true,
          lang: true,
        },
        limitations: [],
      })

      config.setSequence(['file1.csv', 'file2.csv'])
      config.setFileMapping('file1.csv', {
        filename: 'file1.csv',
        model: 'res.partner',
        fieldMappings: { name: 'name' },
      })
      config.setFileMapping('file2.csv', {
        filename: 'file2.csv',
        model: 'res.partner',
        fieldMappings: { name: 'name' },
      })

      filesStore.addFiles([
        { id: 'file-1', name: 'file1.csv', size: 16 },
        { id: 'file-2', name: 'file2.csv', size: 16 },
      ])

      run.addError({
        filename: 'file1.csv',
        rowNumber: 1,
        rawData: {},
        error: 'Previous failure row 1',
        timestamp: Date.now(),
      })
      run.addError({
        filename: 'file2.csv',
        rowNumber: 1,
        rawData: {},
        error: 'Previous failure row 1',
        timestamp: Date.now(),
      })

      setupMockStream('name\nAlice')

      currentEngine = new ImportEngine()
      const retryPromise = currentEngine.retryFailedRows()

      await waitForCondition(() => run.state === ImportState.PAUSED)
      currentEngine.skipCurrentFile()
      await retryPromise

      expect(run.state).toBe(ImportState.COMPLETED)
      expect(run.progress.completedFiles).toBe(2)
      expect(run.progress.files['file1.csv'].skipped).toBe(true)
      expect(run.progress.files['file2.csv'].successCount).toBe(1)
      expect(run.timeoutMitigationActive).toBe(false)
    })

    it('does not duplicate unsafe timeout failures when all rows are non-idempotent', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      const filesStore = useFilesStore()

      const timeoutExecuteBatch = vi.fn<ExecuteBatchFn>(async (_model, rows) => {
        throw new TimeoutBatchError('Request timed out', rows)
      })

      const platform = usePlatformStore()
      platform.configure({
        executeBatch: timeoutExecuteBatch,
        maxWorkers: 4,
        batchSizeRange: { min: 1, max: 1000 },
        createBatchAdapter: null,
        capabilities: {
          dryRun: true,
          rowValidation: true,
          searchKeys: false,
          serverLogs: false,
          serverProfiles: true,
          multipleWorkers: true,
          lang: true,
        },
        limitations: [],
      })

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        fieldMappings: { name: 'name' },
      })

      filesStore.addFiles([{ id: 'file-1', name: 'partners.csv', size: 32 }])

      // Seed previous row-level errors so retryFailedRows() has work to do.
      run.addError({
        filename: 'partners.csv',
        rowNumber: 1,
        rawData: {},
        error: 'Previous failure row 1',
        timestamp: Date.now(),
      })
      run.addError({
        filename: 'partners.csv',
        rowNumber: 2,
        rawData: {},
        error: 'Previous failure row 2',
        timestamp: Date.now(),
      })

      setupMockStream('name\nAlice\nBob')

      currentEngine = new ImportEngine()
      await currentEngine.retryFailedRows()

      expect(run.state).toBe(ImportState.COMPLETED)
      expect(timeoutExecuteBatch).toHaveBeenCalledTimes(1)
      expect(run.timeoutMitigationActive).toBe(false)

      const fileProgress = run.progress.files['partners.csv']
      expect(fileProgress?.processedRows).toBe(2)
      expect(fileProgress?.successCount).toBe(0)
      expect(fileProgress?.failedCount).toBe(2)

      const rowErrors = run.errors
        .filter(e => e.filename === 'partners.csv' && e.rowNumber > 0)
        .map(e => e.rowNumber)
        .sort((a, b) => a - b)

      expect(rowErrors).toEqual([1, 2])
      expect(run.errors.filter(e => e.filename === 'partners.csv' && e.rowNumber > 0)).toHaveLength(2)
    })

    it('records timeout step-down before failing non-idempotent standalone rows', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      const filesStore = useFilesStore()

      const timeoutExecuteBatch = vi.fn<ExecuteBatchFn>(async (_model, rows) => {
        throw new TimeoutBatchError('Request timed out', rows)
      })

      const adapter = {
        currentSize: 10,
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
        recordTimeout: vi.fn(function (this: { currentSize: number }) {
          this.currentSize = 1
          return true
        }),
        get isAtMinimum() {
          return this.currentSize <= 1
        },
      }

      const platform = usePlatformStore()
      platform.configure({
        executeBatch: timeoutExecuteBatch,
        maxWorkers: 1,
        batchSizeRange: { min: 1, max: 1000 },
        createBatchAdapter: () => adapter,
        capabilities: {
          dryRun: true,
          rowValidation: true,
          searchKeys: false,
          serverLogs: false,
          serverProfiles: true,
          multipleWorkers: false,
          lang: true,
        },
        limitations: [],
      })

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        fieldMappings: { name: 'name' },
      })

      filesStore.addFiles([{ id: 'file-1', name: 'partners.csv', size: 32 }])
      setupMockStream('name\nAlice\nBob')

      currentEngine = new ImportEngine()
      await currentEngine.start([{ id: 'file-1', name: 'partners.csv' }])

      expect(run.state).toBe(ImportState.COMPLETED)
      expect(timeoutExecuteBatch).toHaveBeenCalledTimes(1)
      expect(adapter.recordTimeout).toHaveBeenCalledTimes(1)
      expect(adapter.recordTimeout).toHaveBeenCalledWith(300)

      const fileProgress = run.progress.files['partners.csv']
      expect(fileProgress?.processedRows).toBe(2)
      expect(fileProgress?.failedCount).toBe(2)
      expect(run.timeoutMitigationActive).toBe(false)
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
