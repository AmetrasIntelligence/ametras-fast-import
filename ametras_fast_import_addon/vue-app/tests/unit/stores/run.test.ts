import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useRunStore, MAX_ERRORS } from '@/stores/run'
import { ImportState } from '@/types/importState'

describe('RunStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('initial state', () => {
    it('starts with default values', () => {
      const store = useRunStore()
      expect(store.state).toBe(ImportState.IDLE)
      expect(store.progress.totalFiles).toBe(0)
      expect(store.progress.completedFiles).toBe(0)
      expect(store.globalProgress).toBe(0)
      expect(store.errors).toEqual([])
      expect(store.currentFile).toBeNull()
    })
  })

  describe('initRun', () => {
    it('initializes progress for multiple files', () => {
      const store = useRunStore()
      store.initRun(
        ['file1.csv', 'file2.csv', 'file3.csv'],
        new Map([['file1.csv', 100], ['file2.csv', 200], ['file3.csv', 150]])
      )

      expect(store.progress.totalFiles).toBe(3)
      expect(store.progress.completedFiles).toBe(0)
      expect(Object.keys(store.progress.files).length).toBe(3)
    })

    it('sets row counts correctly', () => {
      const store = useRunStore()
      store.initRun(
        ['file1.csv', 'file2.csv'],
        new Map([['file1.csv', 100], ['file2.csv', 200]])
      )

      expect(store.progress.files['file1.csv']?.totalRows).toBe(100)
      expect(store.progress.files['file2.csv']?.totalRows).toBe(200)
    })

    it('resets errors and sets start time', () => {
      const store = useRunStore()
      store.addError({ filename: 'old.csv', rowNumber: 1, rawData: {}, error: 'Old error', timestamp: Date.now() })

      const before = Date.now()
      store.initRun(['new.csv'], new Map([['new.csv', 50]]))

      expect(store.errors).toEqual([])
      expect(store.runStartTime).toBeGreaterThanOrEqual(before)
    })

    it('clears transient state from previous runs', () => {
      const store = useRunStore()
      store.connectionStatus = 'offline'
      store.logId = 111
      store.resumeLogId = 222
      store.isHistoricalLog = true
      store.addError({ filename: 'old.csv', rowNumber: 1, rawData: {}, error: 'Old error', timestamp: Date.now() })

      store.initRun(['new.csv'], new Map([['new.csv', 5]]), true)

      expect(store.connectionStatus).toBe('online')
      expect(store.logId).toBeNull()
      expect(store.resumeLogId).toBeNull()
      expect(store.isHistoricalLog).toBe(false)
      expect(store.errors).toEqual([])
      expect(store.isDryRun).toBe(true)
    })
  })

  describe('file progress', () => {
    beforeEach(() => {
      const store = useRunStore()
      store.initRun(
        ['file1.csv', 'file2.csv'],
        new Map([['file1.csv', 100], ['file2.csv', 200]])
      )
    })

    it('startFile sets current file and start time', () => {
      const store = useRunStore()
      const before = Date.now()
      store.startFile('file1.csv')

      expect(store.progress.currentFileIndex).toBe(0)
      expect(store.currentFile?.filename).toBe('file1.csv')
      expect(store.currentFile?.startTime).toBeGreaterThanOrEqual(before)
    })

    it('updateFileProgress updates counts', () => {
      const store = useRunStore()
      store.startFile('file1.csv')
      store.updateFileProgress('file1.csv', { processedRows: 50, successCount: 48, failedCount: 2 })

      const file = store.progress.files['file1.csv']
      expect(file?.processedRows).toBe(50)
      expect(file?.successCount).toBe(48)
      expect(file?.failedCount).toBe(2)
    })

    it('completeFile sets end time and increments counter', () => {
      const store = useRunStore()
      store.startFile('file1.csv')
      store.completeFile('file1.csv')

      expect(store.currentFile?.endTime).toBeDefined()
      expect(store.progress.completedFiles).toBe(1)
    })
  })

  describe('globalProgress', () => {
    it('calculates progress correctly', () => {
      const store = useRunStore()
      expect(store.globalProgress).toBe(0)

      store.initRun(['file1.csv', 'file2.csv'], new Map([['file1.csv', 100], ['file2.csv', 100]]))
      store.startFile('file1.csv')
      store.updateFileProgress('file1.csv', { processedRows: 50 })
      expect(store.globalProgress).toBe(0.25)

      store.updateFileProgress('file1.csv', { processedRows: 100 })
      store.completeFile('file1.csv')
      store.startFile('file2.csv')
      store.updateFileProgress('file2.csv', { processedRows: 100 })
      expect(store.globalProgress).toBe(1)
    })
  })

  describe('estimatedTimeRemaining', () => {
    it('returns null when no progress', () => {
      const store = useRunStore()
      expect(store.estimatedTimeRemaining).toBeNull()

      store.initRun(['file.csv'], new Map([['file.csv', 100]]))
      expect(store.estimatedTimeRemaining).toBeNull()
    })

    it('calculates ETA based on progress rate', async () => {
      const store = useRunStore()
      store.initRun(['file.csv'], new Map([['file.csv', 100]]))
      store.startFile('file.csv')
      store.updateFileProgress('file.csv', { processedRows: 50 })

      await new Promise(resolve => setTimeout(resolve, 100))

      if (store.globalProgress > 0) {
        expect(store.estimatedTimeRemaining).not.toBeNull()
      }
    })
  })

  describe('errors', () => {
    it('addError appends and accumulates', () => {
      const store = useRunStore()
      store.addError({ filename: 'file.csv', rowNumber: 5, rawData: { id: '1', name: 'Test' }, error: 'Validation failed', timestamp: Date.now() })
      expect(store.errors).toHaveLength(1)
      expect(store.errors[0].rowNumber).toBe(5)

      for (let i = 2; i <= 5; i++) {
        store.addError({ filename: 'file.csv', rowNumber: i, rawData: {}, error: `Error ${i}`, timestamp: Date.now() })
      }
      expect(store.errors).toHaveLength(5)
    })
  })

  describe('hasRetryableErrors', () => {
    it('detects retryable row-level errors', () => {
      const store = useRunStore()
      expect(store.hasRetryableErrors).toBe(false)

      store.addError({ filename: 'file.csv', rowNumber: 0, rawData: {}, error: 'File-level error', timestamp: Date.now() })
      expect(store.hasRetryableErrors).toBe(false)

      store.addError({ filename: 'file.csv', rowNumber: 10, rawData: {}, error: 'Row-level error', timestamp: Date.now() })
      expect(store.hasRetryableErrors).toBe(true)
    })
  })

  describe('setState', () => {
    it('updates state', () => {
      const store = useRunStore()
      store.setState(ImportState.VALIDATING)
      expect(store.state).toBe(ImportState.VALIDATING)
    })
  })

  describe('reset', () => {
    it('resets all state', () => {
      const store = useRunStore()
      store.initRun(['file.csv'], new Map([['file.csv', 100]]))
      store.setState(ImportState.RUNNING_FILE)
      store.connectionStatus = 'offline'
      store.logId = 10
      store.resumeLogId = 20
      store.startFile('file.csv')
      store.updateFileProgress('file.csv', { processedRows: 50 })
      store.addError({ filename: 'file.csv', rowNumber: 1, rawData: {}, error: 'Error', timestamp: Date.now() })

      store.reset()

      expect(store.state).toBe(ImportState.IDLE)
      expect(store.progress.totalFiles).toBe(0)
      expect(Object.keys(store.progress.files).length).toBe(0)
      expect(store.errors).toEqual([])
      expect(store.runStartTime).toBeNull()
      expect(store.connectionStatus).toBe('online')
      expect(store.logId).toBeNull()
      expect(store.resumeLogId).toBeNull()
    })
  })

  describe('skipFile', () => {
    it('excludes skipped files from globalProgress', () => {
      const store = useRunStore()
      store.initRun(
        ['file1.csv', 'file2.csv'],
        new Map([['file1.csv', 100], ['file2.csv', 100]])
      )

      store.startFile('file1.csv')
      store.updateFileProgress('file1.csv', { processedRows: 100, successCount: 100, failedCount: 0 })
      store.completeFile('file1.csv')

      // Skip file2 — globalProgress should be 100% (only file1 counts)
      store.skipFile('file2.csv')

      expect(store.globalProgress).toBe(1)
    })

    it('reports correct progress when all files are skipped', () => {
      const store = useRunStore()
      store.initRun(
        ['file1.csv', 'file2.csv'],
        new Map([['file1.csv', 100], ['file2.csv', 100]])
      )

      store.skipFile('file1.csv')
      store.skipFile('file2.csv')

      // No non-skipped files → total is 0 → globalProgress returns 0
      expect(store.globalProgress).toBe(0)
    })
  })

  describe('monitoring scenarios', () => {
    it('tracks progress through full import', () => {
      const store = useRunStore()
      store.initRun(['partners.csv', 'products.csv'], new Map([['partners.csv', 50], ['products.csv', 100]]))
      store.setState(ImportState.RUNNING_FILE)

      store.startFile('partners.csv')
      store.updateFileProgress('partners.csv', { processedRows: 25, successCount: 24, failedCount: 1 })
      store.updateFileProgress('partners.csv', { processedRows: 50, successCount: 48, failedCount: 2 })
      store.completeFile('partners.csv')

      expect(store.progress.completedFiles).toBe(1)
      expect(store.globalProgress).toBeCloseTo(0.333, 1)

      store.startFile('products.csv')
      store.updateFileProgress('products.csv', { processedRows: 100, successCount: 100, failedCount: 0 })
      store.completeFile('products.csv')

      expect(store.progress.completedFiles).toBe(2)
      expect(store.globalProgress).toBe(1)
    })

    it('tracks errors across files', () => {
      const store = useRunStore()
      store.initRun(['file1.csv', 'file2.csv'], new Map([['file1.csv', 10], ['file2.csv', 10]]))

      store.startFile('file1.csv')
      store.addError({ filename: 'file1.csv', rowNumber: 3, rawData: {}, error: 'E1', timestamp: 1 })
      store.addError({ filename: 'file1.csv', rowNumber: 7, rawData: {}, error: 'E2', timestamp: 2 })

      store.startFile('file2.csv')
      store.addError({ filename: 'file2.csv', rowNumber: 5, rawData: {}, error: 'E3', timestamp: 3 })

      expect(store.errors).toHaveLength(3)
      expect(store.errors.filter(e => e.filename === 'file1.csv')).toHaveLength(2)
      expect(store.errors.filter(e => e.filename === 'file2.csv')).toHaveLength(1)
    })
  })

  describe('completeFile / skipFile guards', () => {
    it('completeFile is idempotent — second call does not double-count', () => {
      const store = useRunStore()
      store.initRun(['file1.csv'], new Map([['file1.csv', 10]]))
      store.startFile('file1.csv')

      store.completeFile('file1.csv')
      const firstEnd = store.progress.files['file1.csv']?.endTime
      expect(store.progress.completedFiles).toBe(1)

      store.completeFile('file1.csv')
      expect(store.progress.completedFiles).toBe(1)
      expect(store.progress.files['file1.csv']?.endTime).toBe(firstEnd)
    })

    it('completeFile on unknown filename is a no-op', () => {
      const store = useRunStore()
      store.initRun(['file1.csv'], new Map([['file1.csv', 10]]))
      store.completeFile('does-not-exist.csv')
      expect(store.progress.completedFiles).toBe(0)
    })

    it('skipFile is idempotent — second call does not double-count', () => {
      const store = useRunStore()
      store.initRun(['file1.csv'], new Map([['file1.csv', 10]]))

      store.skipFile('file1.csv')
      expect(store.progress.completedFiles).toBe(1)
      expect(store.progress.files['file1.csv']?.skipped).toBe(true)

      store.skipFile('file1.csv')
      expect(store.progress.completedFiles).toBe(1)
    })

    it('skipFile after completeFile is a no-op (does not re-mark or double-count)', () => {
      const store = useRunStore()
      store.initRun(['file1.csv'], new Map([['file1.csv', 10]]))
      store.startFile('file1.csv')
      store.completeFile('file1.csv')
      const completedAt = store.progress.files['file1.csv']?.endTime

      store.skipFile('file1.csv')

      expect(store.progress.completedFiles).toBe(1)
      expect(store.progress.files['file1.csv']?.skipped).toBeUndefined()
      expect(store.progress.files['file1.csv']?.endTime).toBe(completedAt)
    })

    it('completeFile after skipFile does not double-count', () => {
      const store = useRunStore()
      store.initRun(['file1.csv'], new Map([['file1.csv', 10]]))
      store.skipFile('file1.csv')
      store.completeFile('file1.csv')
      expect(store.progress.completedFiles).toBe(1)
    })
  })

  describe('setState — strict enum behavior', () => {
    // Sentinel for the historical broken test that used ImportState.RUNNING_BATCH
    // (which does not exist in the enum). Documents that the enum currently has
    // exactly these 7 members so a regression renaming/removing one is caught.
    it('ImportState enum has exactly the expected members', () => {
      expect(Object.values(ImportState).sort()).toEqual([
        'completed',
        'failed',
        'idle',
        'interrupted',
        'paused',
        'running',
        'validating',
      ])
    })

    it('setState accepts every defined enum value', () => {
      const store = useRunStore()
      for (const v of Object.values(ImportState)) {
        store.setState(v as ImportState)
        expect(store.state).toBe(v)
      }
    })
  })

  describe('initRun — state preservation (sentinel for double-start bug)', () => {
    // initRun does NOT reset state.value. A caller that calls initRun
    // without first calling reset() will keep the previous run state.
    // This documents the live behavior and acts as a tripwire: if you
    // ever decide to fix the page-refresh double-start by clearing state
    // here, this test will fail and force you to update both call sites
    // in RunView.startImport().
    it('initRun does not reset state — caller must reset() explicitly', () => {
      const store = useRunStore()
      store.setState(ImportState.RUNNING_FILE)

      store.initRun(['new.csv'], new Map([['new.csv', 5]]))

      expect(store.state).toBe(ImportState.RUNNING_FILE)
    })

    it('reset() followed by initRun() yields a clean IDLE start', () => {
      const store = useRunStore()
      store.setState(ImportState.RUNNING_FILE)
      store.addError({ filename: 'x', rowNumber: 1, rawData: {}, error: 'e', timestamp: 1 })

      store.reset()
      store.initRun(['new.csv'], new Map([['new.csv', 5]]))

      expect(store.state).toBe(ImportState.IDLE)
      expect(store.errors).toEqual([])
      expect(store.logId).toBeNull()
    })
  })

  describe('reset — clears retryRows and isCompleted', () => {
    it('reset clears retryRows', () => {
      const store = useRunStore()
      store.retryRows = new Map([
        ['file1.csv', { rows: [{ rowNum: 1, data: { a: 'b' } }], headers: ['a'] }],
      ])
      store.reset()
      expect(store.retryRows).toBeNull()
    })

    it('reset returns isActive and isCompleted to falsy', () => {
      const store = useRunStore()
      store.setState(ImportState.COMPLETED)
      expect(store.isCompleted).toBe(true)

      store.reset()
      expect(store.isActive).toBe(false)
      expect(store.isCompleted).toBe(false)
    })
  })

  describe('updateFromServer — state mapping', () => {
    function emptyResp(stateStr: string) {
      return {
        state: stateStr,
        progress: {},
        success_rows: 0,
        failed_rows: 0,
        total_rows: 0,
        current_file: '',
        errors: [],
        is_dry_run: false,
      }
    }

    it('maps every known server state string to the right ImportState', () => {
      const store = useRunStore()
      const cases: Array<[string, ImportState]> = [
        ['draft', ImportState.IDLE],
        ['pending', ImportState.VALIDATING],
        ['running', ImportState.RUNNING_FILE],
        ['paused', ImportState.PAUSED],
        ['completed', ImportState.COMPLETED],
        ['failed', ImportState.FAILED],
        ['interrupted', ImportState.INTERRUPTED],
      ]
      for (const [serverState, expected] of cases) {
        store.updateFromServer(emptyResp(serverState))
        expect(store.state).toBe(expected)
      }
    })

    it('falls back to RUNNING_FILE for an unknown server state string', () => {
      const store = useRunStore()
      store.updateFromServer(emptyResp('something-new-and-unmapped'))
      expect(store.state).toBe(ImportState.RUNNING_FILE)
    })

    it('reflects is_dry_run from the server response', () => {
      const store = useRunStore()
      store.updateFromServer({ ...emptyResp('running'), is_dry_run: true })
      expect(store.isDryRun).toBe(true)
      store.updateFromServer({ ...emptyResp('running'), is_dry_run: false })
      expect(store.isDryRun).toBe(false)
    })
  })

  describe('updateFromServer — progress & error deduplication', () => {
    it('reconstructs file progress including skipped flag', () => {
      const store = useRunStore()
      store.updateFromServer({
        state: 'running',
        progress: {
          'a.csv': { totalRows: 10, successCount: 5, failedCount: 1 },
          'b.csv': { totalRows: 20, successCount: 0, failedCount: 0, skipped: true },
        },
        success_rows: 5,
        failed_rows: 1,
        total_rows: 30,
        current_file: 'a.csv',
        errors: [],
        is_dry_run: false,
      })

      expect(store.progress.totalFiles).toBe(2)
      expect(store.progress.files['a.csv']?.processedRows).toBe(6)
      expect(store.progress.files['b.csv']?.skipped).toBe(true)
      expect(store.progress.currentFileIndex).toBe(0)
    })

    it('counts skipped files toward completedFiles', () => {
      const store = useRunStore()
      store.updateFromServer({
        state: 'running',
        progress: {
          'a.csv': { totalRows: 10, successCount: 10, failedCount: 0 },
          'b.csv': { totalRows: 20, successCount: 0, failedCount: 0, skipped: true },
          'c.csv': { totalRows: 30, successCount: 0, failedCount: 0 },
        },
        success_rows: 10,
        failed_rows: 0,
        total_rows: 60,
        current_file: 'c.csv',
        errors: [],
        is_dry_run: false,
      })
      // a.csv fully processed + b.csv skipped → 2 completed
      expect(store.progress.completedFiles).toBe(2)
    })

    it('deduplicates identical errors across multiple polls', () => {
      const store = useRunStore()
      const errPayload = {
        state: 'running',
        progress: {},
        success_rows: 0,
        failed_rows: 1,
        total_rows: 1,
        current_file: '',
        errors: [{ filename: 'a.csv', rowNumber: 7, error: 'Validation failed' }],
        is_dry_run: false,
      }
      store.updateFromServer(errPayload)
      expect(store.errors).toHaveLength(1)

      // Same error again on next poll — must NOT duplicate
      store.updateFromServer(errPayload)
      store.updateFromServer(errPayload)
      expect(store.errors).toHaveLength(1)

      // A different error on the same row is a new entry
      store.updateFromServer({
        ...errPayload,
        errors: [{ filename: 'a.csv', rowNumber: 7, error: 'Different problem' }],
      })
      expect(store.errors).toHaveLength(2)
    })

    it('retains older errors even when server truncates its returned list', () => {
      const store = useRunStore()
      // First poll returns errors 1..3
      store.updateFromServer({
        state: 'running',
        progress: {},
        success_rows: 0,
        failed_rows: 3,
        total_rows: 3,
        current_file: '',
        errors: [
          { filename: 'a.csv', rowNumber: 1, error: 'E1' },
          { filename: 'a.csv', rowNumber: 2, error: 'E2' },
          { filename: 'a.csv', rowNumber: 3, error: 'E3' },
        ],
        is_dry_run: false,
      })
      expect(store.errors).toHaveLength(3)

      // Server now truncates to the last 2 (simulates server-side 100-cap)
      store.updateFromServer({
        state: 'running',
        progress: {},
        success_rows: 0,
        failed_rows: 5,
        total_rows: 5,
        current_file: '',
        errors: [
          { filename: 'a.csv', rowNumber: 4, error: 'E4' },
          { filename: 'a.csv', rowNumber: 5, error: 'E5' },
        ],
        is_dry_run: false,
      })
      // Old errors must be preserved on the frontend even if the server dropped them
      expect(store.errors).toHaveLength(5)
      expect(store.errors.map(e => e.rowNumber).sort()).toEqual([1, 2, 3, 4, 5])
    })

    it('records progress samples on each updateFromServer tick', () => {
      const store = useRunStore()
      store.runStartTime = Date.now() - 1000

      // Two polls with increasing progress
      store.updateFromServer({
        state: 'running',
        progress: { 'a.csv': { totalRows: 100, successCount: 25, failedCount: 0 } },
        success_rows: 25, failed_rows: 0, total_rows: 100,
        current_file: 'a.csv', errors: [], is_dry_run: false,
      })
      store.updateFromServer({
        state: 'running',
        progress: { 'a.csv': { totalRows: 100, successCount: 50, failedCount: 0 } },
        success_rows: 50, failed_rows: 0, total_rows: 100,
        current_file: 'a.csv', errors: [], is_dry_run: false,
      })
      // ETA should now be computable (rate > 0)
      expect(store.globalProgress).toBe(0.5)
    })
  })

  describe('pause / resume / skip / abort lifecycle', () => {
    function progressResp(stateStr: string, currentFile = 'a.csv') {
      return {
        state: stateStr,
        progress: { 'a.csv': { totalRows: 100, successCount: 30, failedCount: 0 } },
        success_rows: 30,
        failed_rows: 0,
        total_rows: 100,
        current_file: currentFile,
        errors: [],
        is_dry_run: false,
      }
    }

    it('running → paused → running round-trip via updateFromServer', () => {
      const store = useRunStore()
      store.updateFromServer(progressResp('running'))
      expect(store.state).toBe(ImportState.RUNNING_FILE)
      expect(store.isActive).toBe(true)

      store.updateFromServer(progressResp('paused'))
      expect(store.state).toBe(ImportState.PAUSED)
      expect(store.isActive).toBe(true) // paused still counts as active

      store.updateFromServer(progressResp('running'))
      expect(store.state).toBe(ImportState.RUNNING_FILE)
    })

    it('progress is preserved across a pause/resume cycle', () => {
      const store = useRunStore()
      store.updateFromServer(progressResp('running'))
      const before = store.globalProgress

      store.updateFromServer(progressResp('paused'))
      expect(store.globalProgress).toBe(before)
      expect(store.progress.files['a.csv']?.successCount).toBe(30)

      store.updateFromServer(progressResp('running'))
      expect(store.globalProgress).toBe(before)
    })

    it('paused → interrupted via abort terminates correctly', () => {
      const store = useRunStore()
      store.updateFromServer(progressResp('running'))
      store.updateFromServer(progressResp('paused'))
      store.updateFromServer(progressResp('interrupted'))

      expect(store.state).toBe(ImportState.INTERRUPTED)
      expect(store.isActive).toBe(false)
    })

    it('running → completed transitions through final state', () => {
      const store = useRunStore()
      store.updateFromServer(progressResp('running'))
      store.updateFromServer({
        ...progressResp('completed'),
        progress: { 'a.csv': { totalRows: 100, successCount: 100, failedCount: 0 } },
        success_rows: 100,
      })
      expect(store.state).toBe(ImportState.COMPLETED)
      expect(store.isActive).toBe(false)
      expect(store.isCompleted).toBe(true)
    })

    it('skip advances current file index on next server tick', () => {
      const store = useRunStore()
      const baseProgress = {
        'a.csv': { totalRows: 100, successCount: 10, failedCount: 0 },
        'b.csv': { totalRows: 100, successCount: 0, failedCount: 0 },
      }
      store.updateFromServer({
        state: 'running',
        progress: baseProgress,
        success_rows: 10, failed_rows: 0, total_rows: 200,
        current_file: 'a.csv', errors: [], is_dry_run: false,
      })
      expect(store.progress.currentFileIndex).toBe(0)

      // After skip, server reports a.csv skipped and moves on to b.csv
      store.updateFromServer({
        state: 'running',
        progress: {
          'a.csv': { totalRows: 100, successCount: 10, failedCount: 0, skipped: true },
          'b.csv': { totalRows: 100, successCount: 5, failedCount: 0 },
        },
        success_rows: 15, failed_rows: 0, total_rows: 200,
        current_file: 'b.csv', errors: [], is_dry_run: false,
      })
      expect(store.progress.currentFileIndex).toBe(1)
      expect(store.progress.files['a.csv']?.skipped).toBe(true)
    })

    it('full reset after abort returns store to a startable IDLE state', () => {
      const store = useRunStore()
      store.initRun(['a.csv'], new Map([['a.csv', 100]]))
      store.setState(ImportState.RUNNING_FILE)
      store.logId = 42
      store.updateFileProgress('a.csv', { processedRows: 30, successCount: 30, failedCount: 0 })
      store.addError({ filename: 'a.csv', rowNumber: 5, rawData: {}, error: 'boom', timestamp: 1 })
      // simulate abort → server reports interrupted
      store.setState(ImportState.INTERRUPTED)

      // Reset is the critical step that lets the next import start —
      // this is the canary for the "imports got stuck, no new one would start" bug.
      store.reset()

      expect(store.state).toBe(ImportState.IDLE)
      expect(store.isActive).toBe(false)
      expect(store.isCompleted).toBe(false)
      expect(store.logId).toBeNull()
      expect(store.progress.totalFiles).toBe(0)
      expect(store.progress.completedFiles).toBe(0)
      expect(Object.keys(store.progress.files)).toHaveLength(0)
      expect(store.errors).toEqual([])
      expect(store.runStartTime).toBeNull()
      expect(store.retryRows).toBeNull()
      expect(store.connectionStatus).toBe('online')
    })

    it('errorKeys dedup set is cleared on reset (next run starts fresh)', () => {
      const store = useRunStore()
      const errPayload = {
        state: 'running',
        progress: {},
        success_rows: 0, failed_rows: 1, total_rows: 1,
        current_file: '',
        errors: [{ filename: 'a.csv', rowNumber: 1, error: 'same' }],
        is_dry_run: false,
      }
      store.updateFromServer(errPayload)
      expect(store.errors).toHaveLength(1)

      store.reset()

      // A fresh run with the exact same error fingerprint must record it again —
      // proves the internal errorKeys Set was cleared by reset().
      store.updateFromServer(errPayload)
      expect(store.errors).toHaveLength(1)
      expect(store.errors[0].error).toBe('same')
    })

    it('errorKeys persistence within a single run prevents duplicates', () => {
      const store = useRunStore()
      const errPayload = {
        state: 'running',
        progress: {},
        success_rows: 0, failed_rows: 1, total_rows: 1,
        current_file: '',
        errors: [{ filename: 'a.csv', rowNumber: 1, error: 'same' }],
        is_dry_run: false,
      }
      store.updateFromServer(errPayload)
      store.updateFromServer(errPayload)
      expect(store.errors).toHaveLength(1)
    })

    it('connectionStatus flips offline → online does not lose progress', () => {
      const store = useRunStore()
      store.updateFromServer(progressResp('running'))
      store.connectionStatus = 'offline'
      const before = store.globalProgress

      // poll succeeds again — connection-status reset is the caller's job (RunView),
      // but updateFromServer must not blow away progress.
      store.updateFromServer(progressResp('running'))
      expect(store.globalProgress).toBe(before)
    })
  })

  describe('isActive / isCompleted invariants', () => {
    it('idle is neither active nor completed', () => {
      const store = useRunStore()
      expect(store.isActive).toBe(false)
      expect(store.isCompleted).toBe(false)
    })

    it('every state is consistently classified', () => {
      const store = useRunStore()
      const expectations: Array<[ImportState, boolean, boolean]> = [
        // [state, isActive, isCompleted]
        [ImportState.IDLE, false, false],
        [ImportState.VALIDATING, true, false],
        [ImportState.RUNNING_FILE, true, false],
        [ImportState.PAUSED, true, false],
        [ImportState.COMPLETED, false, true],
        [ImportState.FAILED, false, true],
        [ImportState.INTERRUPTED, false, false],
      ]
      for (const [s, active, completed] of expectations) {
        store.setState(s)
        expect(store.isActive, `isActive for ${s}`).toBe(active)
        expect(store.isCompleted, `isCompleted for ${s}`).toBe(completed)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // P1.3 — stall detection
  // ---------------------------------------------------------------------------
  describe('heartbeat / stall detection', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('updateFromServer records heartbeat when provided', () => {
      const store = useRunStore()
      store.initRun(['f.csv'], new Map([['f.csv', 10]]))
      store.setState(ImportState.RUNNING_FILE)
      const ts = new Date().toISOString()
      store.updateFromServer({
        state: 'running', progress: {}, success_rows: 0,
        failed_rows: 0, total_rows: 10, current_file: '',
        errors: [], is_dry_run: false, heartbeat: ts,
      })
      expect(store.lastHeartbeat).toBe(ts)
    })

    it('isStalled is false before any heartbeat', () => {
      const store = useRunStore()
      store.initRun(['f.csv'], new Map([['f.csv', 10]]))
      store.setState(ImportState.RUNNING_FILE)
      expect(store.isStalled).toBe(false)
    })

    it('isStalled flips true when heartbeat age exceeds threshold', () => {
      vi.useFakeTimers()
      const store = useRunStore()
      store.initRun(['f.csv'], new Map([['f.csv', 10]]))
      store.setState(ImportState.RUNNING_FILE)
      const oldTs = new Date(Date.now() - 200_000).toISOString()  // 200s ago > 90s threshold
      store.updateFromServer({
        state: 'running', progress: {}, success_rows: 0,
        failed_rows: 0, total_rows: 10, current_file: '',
        errors: [], is_dry_run: false, heartbeat: oldTs,
      })
      expect(store.isStalled).toBe(true)
    })

    it('isStalled flips back to false after a fresh heartbeat', () => {
      vi.useFakeTimers()
      const store = useRunStore()
      store.initRun(['f.csv'], new Map([['f.csv', 10]]))
      store.setState(ImportState.RUNNING_FILE)
      const oldTs = new Date(Date.now() - 200_000).toISOString()
      store.updateFromServer({
        state: 'running', progress: {}, success_rows: 0,
        failed_rows: 0, total_rows: 10, current_file: '',
        errors: [], is_dry_run: false, heartbeat: oldTs,
      })
      expect(store.isStalled).toBe(true)

      const freshTs = new Date().toISOString()
      store.updateFromServer({
        state: 'running', progress: {}, success_rows: 0,
        failed_rows: 0, total_rows: 10, current_file: '',
        errors: [], is_dry_run: false, heartbeat: freshTs,
      })
      expect(store.isStalled).toBe(false)
    })

    it('isStalled is suppressed while connectionStatus is offline', () => {
      vi.useFakeTimers()
      const store = useRunStore()
      store.initRun(['f.csv'], new Map([['f.csv', 10]]))
      store.setState(ImportState.RUNNING_FILE)
      store.connectionStatus = 'offline'
      const oldTs = new Date(Date.now() - 200_000).toISOString()
      store.updateFromServer({
        state: 'running', progress: {}, success_rows: 0,
        failed_rows: 0, total_rows: 10, current_file: '',
        errors: [], is_dry_run: false, heartbeat: oldTs,
      })
      expect(store.isStalled).toBe(false)  // suppressed by offline status
    })

    it('stallThresholdMs scales with batchSize — small batch < large batch', () => {
      const store = useRunStore()
      expect(store.stallThresholdMs(10)).toBeLessThan(store.stallThresholdMs(1000))
    })

    it('stallThresholdMs has a 90s floor', () => {
      const store = useRunStore()
      expect(store.stallThresholdMs(1)).toBeGreaterThanOrEqual(90_000)
      expect(store.stallThresholdMs(0)).toBeGreaterThanOrEqual(90_000)
    })

    it('reset clears lastHeartbeat', () => {
      const store = useRunStore()
      store.initRun(['f.csv'], new Map([['f.csv', 10]]))
      store.updateFromServer({
        state: 'running', progress: {}, success_rows: 0,
        failed_rows: 0, total_rows: 10, current_file: '',
        errors: [], is_dry_run: false, heartbeat: new Date().toISOString(),
      })
      store.reset()
      expect(store.lastHeartbeat).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // P3.6 — errors memory cap
  // ---------------------------------------------------------------------------
  describe('errors memory cap', () => {
    it('caps display errors at MAX_ERRORS by hard-stopping (no eviction)', () => {
      const store = useRunStore()
      store.initRun(['f.csv'], new Map([['f.csv', MAX_ERRORS + 10]]))
      for (let i = 0; i < MAX_ERRORS + 5; i++) {
        store.addError({ filename: 'f.csv', rowNumber: i + 1, rawData: {}, error: `e${i}`, timestamp: i })
      }
      expect(store.errors).toHaveLength(MAX_ERRORS)
      // First MAX_ERRORS are kept (no eviction); first row number is still 1
      const rowNums = store.errors.map(e => e.rowNumber)
      expect(rowNums[0]).toBe(1)
      expect(rowNums[MAX_ERRORS - 1]).toBe(MAX_ERRORS)
    })

    it('downloadErrors accumulates all errors beyond the display cap', () => {
      const store = useRunStore()
      store.initRun(['f.csv'], new Map([['f.csv', MAX_ERRORS + 10]]))
      for (let i = 0; i < MAX_ERRORS + 5; i++) {
        store.addError({ filename: 'f.csv', rowNumber: i + 1, rawData: {}, error: `e${i}`, timestamp: i })
      }
      expect(store.downloadErrors).toHaveLength(MAX_ERRORS + 5)
    })

    it('totalErrorsSeen tracks lifetime count beyond the cap', () => {
      const store = useRunStore()
      store.initRun(['f.csv'], new Map([['f.csv', MAX_ERRORS + 10]]))
      for (let i = 0; i < MAX_ERRORS + 5; i++) {
        store.addError({ filename: 'f.csv', rowNumber: i + 1, rawData: {}, error: `e${i}`, timestamp: i })
      }
      expect(store.totalErrorsSeen).toBe(MAX_ERRORS + 5)
    })

    it('reset clears totalErrorsSeen and downloadErrors', () => {
      const store = useRunStore()
      store.initRun(['f.csv'], new Map([['f.csv', 10]]))
      store.addError({ filename: 'f.csv', rowNumber: 1, rawData: {}, error: 'e', timestamp: 0 })
      store.reset()
      expect(store.totalErrorsSeen).toBe(0)
      expect(store.downloadErrors).toHaveLength(0)
    })
  })
})
