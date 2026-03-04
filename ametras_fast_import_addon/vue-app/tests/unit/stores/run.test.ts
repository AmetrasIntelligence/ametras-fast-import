import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useRunStore } from '@/stores/run'
import { ImportState } from '@/importer/stateMachine'

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
      store.startFile('file.csv')
      store.updateFileProgress('file.csv', { processedRows: 50 })
      store.addError({ filename: 'file.csv', rowNumber: 1, rawData: {}, error: 'Error', timestamp: Date.now() })

      store.reset()

      expect(store.state).toBe(ImportState.IDLE)
      expect(store.progress.totalFiles).toBe(0)
      expect(Object.keys(store.progress.files).length).toBe(0)
      expect(store.errors).toEqual([])
      expect(store.runStartTime).toBeNull()
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

    it('excludes skipped files from pendingRows', () => {
      const store = useRunStore()
      store.initRun(
        ['file1.csv', 'file2.csv'],
        new Map([['file1.csv', 50], ['file2.csv', 200]])
      )

      store.startFile('file1.csv')
      store.updateFileProgress('file1.csv', { processedRows: 50, successCount: 40, failedCount: 10 })
      store.completeFile('file1.csv')

      // Skip file2 — pendingRows should only reflect file1
      store.skipFile('file2.csv')

      // file1: total=50, success=40, failed=10 → pending=0
      expect(store.pendingRows).toBe(0)
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
      expect(store.pendingRows).toBe(0)
    })
  })

  describe('monitoring scenarios', () => {
    it('tracks progress through full import', () => {
      const store = useRunStore()
      store.initRun(['partners.csv', 'products.csv'], new Map([['partners.csv', 50], ['products.csv', 100]]))
      store.setState(ImportState.RUNNING_FILE)

      store.startFile('partners.csv')
      store.setState(ImportState.RUNNING_BATCH)
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
})
