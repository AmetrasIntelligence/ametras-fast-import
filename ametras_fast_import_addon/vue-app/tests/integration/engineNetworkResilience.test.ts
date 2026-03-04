import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia, type Pinia } from 'pinia'
import { setupMockStream, resetMockStreams, mockApi } from '../setup'
import { ImportEngine } from '@/importer/engine'
import { ImportState } from '@/importer/stateMachine'
import { NetworkBatchError } from '@/importer/batchExecutor'
import { useConfigStore } from '@/stores/config'
import { useRunStore } from '@/stores/run'
import { usePlatformStore, type ExecuteBatchFn } from '@/stores/platform'
import { useSessionStore } from '@/stores/session'

// Suppress log output in tests (must include worker.debug for WorkerPool)
vi.mock('@/utils/logger', () => ({
  logger: {
    import: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    worker: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    debug: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Advance fake timers in small increments until `predicate` returns true.
 * Yields the microtask queue between each tick so engine state machines
 * can settle.
 */
async function waitForCondition(
  predicate: () => boolean,
  { maxIterations = 2000, tickMs = 50 } = {}
): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return
    await vi.advanceTimersByTimeAsync(tickMs)
  }
  throw new Error('waitForCondition: timed out')
}

/** Advance past the first ConnectionMonitor health-check backoff (1 000 ms). */
async function advancePastFirstHealthCheck(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1100)
}

const SIMPLE_CSV = 'id,name\nrow_1,Alice\nrow_2,Bob\nrow_3,Carol'

function setupSingleFile(config: ReturnType<typeof useConfigStore>): void {
  config.setSettings({ retryLimit: 2, retryDelayMs: 0, batchSize: 200, workers: 1 })
  config.setSequence(['file1.csv'])
  config.setFileMapping('file1.csv', {
    filename: 'file1.csv',
    model: 'res.partner',
    idColumn: 'id',
    fieldMappings: { id: 'id', name: 'name' },
  })
  setupMockStream(SIMPLE_CSV)
}

function setupTwoFiles(config: ReturnType<typeof useConfigStore>): void {
  config.setSettings({ retryLimit: 2, retryDelayMs: 0, batchSize: 200, workers: 1 })
  config.setSequence(['file1.csv', 'file2.csv'])
  config.setFileMapping('file1.csv', {
    filename: 'file1.csv',
    model: 'res.partner',
    idColumn: 'id',
    fieldMappings: { id: 'id', name: 'name' },
  })
  config.setFileMapping('file2.csv', {
    filename: 'file2.csv',
    model: 'res.partner',
    idColumn: 'id',
    fieldMappings: { id: 'id', name: 'name' },
  })
  setupMockStream(SIMPLE_CSV)
}

function successResult(rows: { index: number }[]) {
  return rows.map((row, idx) => ({
    ok: true as const,
    rowIndex: row.index ?? idx,
    createdId: idx + 1,
    externalId: `ext_${idx + 1}`,
  }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Engine Network Resilience', () => {
  let pinia: Pinia
  let currentEngine: ImportEngine | null = null
  let mockExecuteBatch: ReturnType<typeof vi.fn<ExecuteBatchFn>>

  beforeEach(() => {
    vi.useFakeTimers()
    pinia = createPinia()
    setActivePinia(pinia)
    vi.clearAllMocks()
    resetMockStreams()

    mockExecuteBatch = vi.fn<ExecuteBatchFn>()

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
        serverLogs: false,
        serverProfiles: true,
        multipleWorkers: true,
        lang: true,
      },
      limitations: [],
    })

    // Standalone session so engine creates health check via window.api.odoo.ping
    const session = useSessionStore(pinia)
    session.setAuthenticated(
      { id: 'test', name: 'Test', baseUrl: 'http://localhost:8069', db: 'test' },
      1,
      '16.0',
    )

    // Default: ping succeeds (online)
    ;(mockApi.odoo as Record<string, unknown>).ping = vi.fn().mockResolvedValue({ ok: true })
  })

  afterEach(async () => {
    if (currentEngine) {
      currentEngine.abort()
      currentEngine = null
    }
    vi.useRealTimers()
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  // -----------------------------------------------------------------------
  // Test 1
  // -----------------------------------------------------------------------
  describe('batch-level network error recovery', () => {
    it('pauses on NetworkBatchError, waits for reconnection, retries, completes', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      setupSingleFile(config)

      // Call 1: throw NetworkBatchError. Calls 2+: succeed.
      let callCount = 0
      mockExecuteBatch.mockImplementation(async (_model, rows) => {
        callCount++
        if (callCount === 1) {
          throw new NetworkBatchError('Connection lost', rows)
        }
        return successResult(rows)
      })

      currentEngine = new ImportEngine()
      const importPromise = currentEngine.start([{ id: 'f1', name: 'file1.csv' }])

      // Wait for PAUSED state (engine hit the network error)
      await waitForCondition(() => run.state === ImportState.PAUSED)
      expect(run.connectionStatus).toBe('offline')

      // Advance past the first health check backoff so monitor detects online
      await advancePastFirstHealthCheck()

      // Engine should resume and complete
      await waitForCondition(() => run.state === ImportState.COMPLETED)
      await importPromise

      expect(run.state).toBe(ImportState.COMPLETED)
      expect(run.connectionStatus).toBe('online')
      expect(mockExecuteBatch).toHaveBeenCalledTimes(2)
    })
  })

  // -----------------------------------------------------------------------
  // Test 2
  // -----------------------------------------------------------------------
  describe('abort during reconnection wait', () => {
    it('terminates cleanly on abort() during reconnection', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      setupSingleFile(config)

      // All calls throw — never recovers
      mockExecuteBatch.mockImplementation(async (_model, rows) => {
        throw new NetworkBatchError('Connection lost', rows)
      })

      currentEngine = new ImportEngine()
      const importPromise = currentEngine.start([{ id: 'f1', name: 'file1.csv' }])

      // Wait for PAUSED state
      await waitForCondition(() => run.state === ImportState.PAUSED)

      // Abort while waiting for reconnection
      currentEngine.abort()
      await importPromise

      expect(run.state).toBe(ImportState.FAILED)
      expect(run.isInitiating).toBe(false)
      expect(run.isPausing).toBe(false)
      expect(run.isSkipping).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Test 3
  // -----------------------------------------------------------------------
  describe('skip file during batch reconnection wait', () => {
    it('skips file and processes next file', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      setupTwoFiles(config)

      // Call 1: throw (file1). Calls 2+: succeed (file2).
      let callCount = 0
      mockExecuteBatch.mockImplementation(async (_model, rows) => {
        callCount++
        if (callCount === 1) {
          throw new NetworkBatchError('Connection lost', rows)
        }
        return successResult(rows)
      })

      currentEngine = new ImportEngine()
      const importPromise = currentEngine.start([
        { id: 'f1', name: 'file1.csv' },
        { id: 'f2', name: 'file2.csv' },
      ])

      // Wait for PAUSED state (file1 network error)
      await waitForCondition(() => run.state === ImportState.PAUSED)

      // Skip file1
      currentEngine.skipCurrentFile()

      // Engine should continue to file2 and complete
      await waitForCondition(() => run.state === ImportState.COMPLETED)
      await importPromise

      expect(run.progress.files['file1.csv'].skipped).toBe(true)
      expect(run.progress.completedFiles).toBe(2)
      expect(run.state).toBe(ImportState.COMPLETED)
    })
  })

  // -----------------------------------------------------------------------
  // Test 4
  // -----------------------------------------------------------------------
  describe('skip during retry reconnection wait (bug fix)', () => {
    it('properly skips file when skipped during retry reconnection', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      setupTwoFiles(config)

      // Two-phase approach to reliably populate the retry queue:
      // Call 1: NetworkBatchError (initial batch) → PAUSED → health-check reconnect
      // Call 2: partial failure (same batch retried after reconnect) → retry queue populated
      // Call 3: NetworkBatchError (processRetries) → second PAUSED
      // Skip file1 during second PAUSED
      // Call 4: success (file2 batch)
      let callCount = 0
      mockExecuteBatch.mockImplementation(async (_model, rows) => {
        callCount++
        if (callCount === 1) {
          throw new NetworkBatchError('Connection lost', rows)
        }
        if (callCount === 2) {
          // Partial failure — first row fails, rest succeed
          return rows.map((row, idx) => ({
            ok: idx !== 0,
            rowIndex: row.index,
            ...(idx === 0 ? { error: 'Validation error' } : { createdId: idx }),
          }))
        }
        if (callCount === 3) {
          throw new NetworkBatchError('Connection lost during retry', rows)
        }
        return successResult(rows)
      })

      currentEngine = new ImportEngine()
      const importPromise = currentEngine.start([
        { id: 'f1', name: 'file1.csv' },
        { id: 'f2', name: 'file2.csv' },
      ])

      // Wait for first PAUSED (initial batch network error)
      await waitForCondition(() => run.state === ImportState.PAUSED)
      expect(callCount).toBe(1)

      // Reconnect: advance past health check
      await advancePastFirstHealthCheck()

      // Wait for second PAUSED (processRetries network error)
      await waitForCondition(() => run.state === ImportState.PAUSED && callCount >= 3)

      // Skip file1 while retries are waiting for reconnection
      currentEngine.skipCurrentFile()

      // Engine should continue to file2 and complete
      await waitForCondition(() => run.state === ImportState.COMPLETED)
      await importPromise

      // file1 should be properly marked as skipped (not left in limbo)
      expect(run.progress.files['file1.csv'].skipped).toBe(true)
      expect(run.state).toBe(ImportState.COMPLETED)
    })
  })

  // -----------------------------------------------------------------------
  // Test 5
  // -----------------------------------------------------------------------
  describe('state normalization prevents stale RETRYING', () => {
    it('file2 retries work after file1 retries skipped', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      setupTwoFiles(config)

      // Two-phase approach (same as test 4) to reliably reach processRetries:
      // Call 1: NetworkBatchError (file1 initial batch) → PAUSED → reconnect
      // Call 2: partial failure (file1 batch retried) → retry queue populated
      // Call 3: NetworkBatchError (file1 processRetries) → second PAUSED → skip
      // Call 4: partial failure (file2 batch) → file2 retry queue populated
      // Call 5: success (file2 processRetries)
      let callCount = 0
      mockExecuteBatch.mockImplementation(async (_model, rows) => {
        callCount++
        if (callCount === 1) {
          throw new NetworkBatchError('Connection lost', rows)
        }
        if (callCount === 2) {
          // file1 batch retried: first row fails
          return rows.map((row, idx) => ({
            ok: idx !== 0,
            rowIndex: row.index,
            ...(idx === 0 ? { error: 'Error A' } : { createdId: idx }),
          }))
        }
        if (callCount === 3) {
          // file1 retry: network error
          throw new NetworkBatchError('Connection lost', rows)
        }
        if (callCount === 4) {
          // file2 batch: first row fails
          return rows.map((row, idx) => ({
            ok: idx !== 0,
            rowIndex: row.index,
            ...(idx === 0 ? { error: 'Error B' } : { createdId: idx }),
          }))
        }
        // Call 5+: file2 retry succeeds
        return successResult(rows)
      })

      currentEngine = new ImportEngine()
      const importPromise = currentEngine.start([
        { id: 'f1', name: 'file1.csv' },
        { id: 'f2', name: 'file2.csv' },
      ])

      // Wait for first PAUSED (file1 initial batch network error)
      await waitForCondition(() => run.state === ImportState.PAUSED)

      // Reconnect
      await advancePastFirstHealthCheck()

      // Wait for second PAUSED (file1 retry network error)
      await waitForCondition(() => run.state === ImportState.PAUSED && callCount >= 3)

      // Skip file1
      currentEngine.skipCurrentFile()

      // Engine should process file2 (including retries) and complete
      await waitForCondition(() => run.state === ImportState.COMPLETED)
      await importPromise

      // callCount === 5 proves file2 retry ran (RUNNING_FILE → RETRYING transition succeeded)
      expect(callCount).toBe(5)
      expect(run.progress.files['file1.csv'].skipped).toBe(true)
      expect(run.progress.files['file2.csv'].skipped).toBeUndefined()
      expect(run.state).toBe(ImportState.COMPLETED)
    })
  })

  // -----------------------------------------------------------------------
  // Test 6
  // -----------------------------------------------------------------------
  describe('transitional flag cleanup — skip', () => {
    it('flags are false after skip and completion', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      setupTwoFiles(config)

      // Call 1: throw (file1). Calls 2+: succeed (file2).
      let callCount = 0
      mockExecuteBatch.mockImplementation(async (_model, rows) => {
        callCount++
        if (callCount === 1) {
          throw new NetworkBatchError('Connection lost', rows)
        }
        return successResult(rows)
      })

      currentEngine = new ImportEngine()
      const importPromise = currentEngine.start([
        { id: 'f1', name: 'file1.csv' },
        { id: 'f2', name: 'file2.csv' },
      ])

      await waitForCondition(() => run.state === ImportState.PAUSED)

      currentEngine.skipCurrentFile()

      await waitForCondition(() => run.state === ImportState.COMPLETED)
      await importPromise

      expect(run.isInitiating).toBe(false)
      expect(run.isPausing).toBe(false)
      expect(run.isSkipping).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Test 7
  // -----------------------------------------------------------------------
  describe('transitional flag cleanup — abort', () => {
    it('flags are false after abort during reconnection', async () => {
      const config = useConfigStore()
      const run = useRunStore()
      setupSingleFile(config)

      mockExecuteBatch.mockImplementation(async (_model, rows) => {
        throw new NetworkBatchError('Connection lost', rows)
      })

      currentEngine = new ImportEngine()
      const importPromise = currentEngine.start([{ id: 'f1', name: 'file1.csv' }])

      await waitForCondition(() => run.state === ImportState.PAUSED)

      currentEngine.abort()
      // Prevent afterEach from double-aborting
      const engine = currentEngine
      currentEngine = null
      await importPromise

      expect(run.isInitiating).toBe(false)
      expect(run.isPausing).toBe(false)
      expect(run.isSkipping).toBe(false)
      expect(run.state).toBe(ImportState.FAILED)

      // Still need to reference engine to avoid GC before promise settles
      void engine
    })
  })

  // -----------------------------------------------------------------------
  // Test 8
  // -----------------------------------------------------------------------
  describe('multiple workers + network error', () => {
    it('all workers fail, single pause, single recovery', async () => {
      const config = useConfigStore()
      const run = useRunStore()

      config.setSettings({ retryLimit: 0, retryDelayMs: 0, batchSize: 1, workers: 3 })
      config.setSequence(['file1.csv'])
      config.setFileMapping('file1.csv', {
        filename: 'file1.csv',
        model: 'res.partner',
        idColumn: 'id',
        fieldMappings: { id: 'id', name: 'name' },
      })
      setupMockStream(SIMPLE_CSV)

      // First 3 calls throw (one per worker), rest succeed
      let callCount = 0
      mockExecuteBatch.mockImplementation(async (_model, rows) => {
        callCount++
        if (callCount <= 3) {
          throw new NetworkBatchError('Connection lost', rows)
        }
        return successResult(rows)
      })

      currentEngine = new ImportEngine()
      const importPromise = currentEngine.start([{ id: 'f1', name: 'file1.csv' }])

      // Wait for PAUSED state
      await waitForCondition(() => run.state === ImportState.PAUSED)

      // Advance past health check to reconnect
      await advancePastFirstHealthCheck()

      // Engine should recover and complete
      await waitForCondition(() => run.state === ImportState.COMPLETED)
      await importPromise

      expect(run.state).toBe(ImportState.COMPLETED)
      expect(run.connectionStatus).toBe('online')
    })
  })
})
