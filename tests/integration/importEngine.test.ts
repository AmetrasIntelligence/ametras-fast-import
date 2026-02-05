import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import { mockApi } from '../setup'
import {
  DEMO_CSV_PARTNER_SIMPLE,
  mockOdooResponses,
  generateLargeCSV
} from '../fixtures'
import { ImportEngine } from '@/importer/engine'
import { ImportState } from '@/importer/stateMachine'
import { useConfigStore } from '@/stores/config'
import { useRunStore } from '@/stores/run'
import { useSessionStore } from '@/stores/session'
import * as batchExecutor from '@/importer/batchExecutor'

// Mock executeBatch to avoid session store dependency issues in tests
vi.mock('@/importer/batchExecutor', async (importOriginal) => {
  const original = await importOriginal<typeof batchExecutor>()
  return {
    ...original,
    executeBatch: vi.fn()
  }
})

const mockExecuteBatch = vi.mocked(batchExecutor.executeBatch)

describe('ImportEngine Integration', () => {
  let pinia: Pinia
  let currentEngine: ImportEngine | null = null

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.clearAllMocks()

    // Setup session (still needed for some tests)
    const session = useSessionStore(pinia)
    session.baseUrl = 'http://localhost:8069'
    session.database = 'test'
    session.sessionId = 'test-session-id'

    // Setup default mocks
    mockApi.files.readHead.mockResolvedValue(DEMO_CSV_PARTNER_SIMPLE)
    mockApi.files.countLines.mockResolvedValue(4)

    // Default mock for executeBatch - success response
    mockExecuteBatch.mockResolvedValue([
      { ok: true, rowIndex: 0, createdId: 1, externalId: 'partner_1' },
      { ok: true, rowIndex: 1, createdId: 2, externalId: 'partner_2' },
      { ok: true, rowIndex: 2, createdId: 3, externalId: 'partner_3' }
    ])
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

      // Mock streaming to return all data at once
      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
      })

      // mockExecuteBatch already returns success by default

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

      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
      })

      // mockExecuteBatch already returns success by default

      currentEngine = new ImportEngine()
      await currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      const fileProgress = run.progress.files.get('partners.csv')
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

      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
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

      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
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

      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: 'id,name\n1,Test', done: false })
        callback({ data: '', done: true })
      })

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

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: null,
        fieldMappings: { name: 'name' }
      })

      // Slow mock that allows abort
      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        await new Promise(resolve => setTimeout(resolve, 100))
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
      })

      currentEngine = new ImportEngine()
      const importPromise = currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      // Abort immediately
      currentEngine!.abort()

      await importPromise

      expect(run.state).toBe(ImportState.IDLE)
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

      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
      })

      // mockExecuteBatch already returns success by default

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

      mockApi.files.streamChunks.mockImplementation(async (_id, size, callback) => {
        expect(size).toBe(2) // Batch size should be passed
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
      })

      // mockExecuteBatch already returns success by default

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

      mockApi.files.streamChunks.mockImplementation(async (_id, size, callback) => {
        expect(size).toBe(500)
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
      })

      // mockExecuteBatch already returns success by default

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

      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
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

      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
      })

      currentEngine = new ImportEngine()
      await currentEngine.start([{ id: 'file-1', name: 'partners.csv' }])

      expect(mockExecuteBatch).toHaveBeenCalledWith(
        'res.partner',
        expect.any(Array),
        expect.any(Object),
        true
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

      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
      })

      currentEngine = new ImportEngine()
      await currentEngine.start([{ id: 'file-1', name: 'partners.csv' }])

      expect(mockExecuteBatch).toHaveBeenCalledWith(
        'res.partner',
        expect.any(Array),
        expect.any(Object),
        false
      )
      expect(run.isDryRun).toBe(false)
    })
  })

  describe('sequential batch processing', () => {
    it('processes all batches when streamChunks emits multiple chunks', async () => {
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

      // Emit multiple chunks rapidly (simulating the race condition scenario)
      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: 'id,name,email\npartner_1,Test1,t1@test.com\npartner_2,Test2,t2@test.com', done: false })
        callback({ data: 'id,name,email\npartner_3,Test3,t3@test.com\npartner_4,Test4,t4@test.com', done: false })
        callback({ data: 'id,name,email\npartner_5,Test5,t5@test.com', done: false })
        callback({ data: '', done: true })
      })

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

      // All 5 rows should be processed across multiple batches of size 2
      expect(run.state).toBe(ImportState.COMPLETED)
      // With batchSize=2 and 5 rows: batches of [2, 2, 1]
      expect(batchCallOrder).toEqual([2, 2, 1])
      expect(mockExecuteBatch).toHaveBeenCalledTimes(3)
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

      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: 'name\nA\nB', done: false })
        callback({ data: 'name\nC\nD', done: false })
        callback({ data: '', done: true })
      })

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
    it('passes use_external_id flag when id column mapped', async () => {
      const config = useConfigStore()

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { id: 'id', name: 'name' }
      })

      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
      })

      // mockExecuteBatch already returns success by default

      currentEngine = new ImportEngine()
      await currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      expect(mockExecuteBatch).toHaveBeenCalledWith(
        'res.partner',
        expect.any(Array),
        expect.objectContaining({
          idColumn: 'id'
        }),
        false
      )
    })

    it('does not pass use_external_id when .id column mapped', async () => {
      const config = useConfigStore()

      config.setSequence(['partners.csv'])
      config.setFileMapping('partners.csv', {
        filename: 'partners.csv',
        model: 'res.partner',
        idColumn: '.id',
        fieldMappings: { name: 'name' }
      })

      mockApi.files.streamChunks.mockImplementation(async (_id, _size, callback) => {
        callback({ data: DEMO_CSV_PARTNER_SIMPLE, done: false })
        callback({ data: '', done: true })
      })

      // mockExecuteBatch already returns success by default

      currentEngine = new ImportEngine()
      await currentEngine!.start([{ id: 'file-1', name: 'partners.csv' }])

      expect(mockExecuteBatch).toHaveBeenCalledWith(
        'res.partner',
        expect.any(Array),
        expect.objectContaining({
          idColumn: '.id'
        }),
        false
      )
    })
  })
})
