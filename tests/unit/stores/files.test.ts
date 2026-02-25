import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useFilesStore, type FileAnalysis } from '@/stores/files'

function makeAnalysis(overrides: Partial<FileAnalysis> = {}): FileAnalysis {
  return {
    headers: ['name', 'email'],
    rowCount: 100,
    sampleRows: [{ name: 'Alice', email: 'a@b.com' }],
    delimiter: ',',
    hasIdColumn: false,
    hasDotIdColumn: false,
    ...overrides
  }
}

describe('FilesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('initial state', () => {
    it('starts with empty files', () => {
      const store = useFilesStore()
      expect(store.files).toEqual([])
    })

    it('has zero file count', () => {
      const store = useFilesStore()
      expect(store.fileCount).toBe(0)
    })

    it('has no analyses', () => {
      const store = useFilesStore()
      expect(Object.keys(store.analyses).length).toBe(0)
    })
  })

  describe('addFiles', () => {
    it('adds new files', () => {
      const store = useFilesStore()
      store.addFiles([
        { id: '1', name: 'a.csv', size: 100 },
        { id: '2', name: 'b.csv', size: 200 }
      ])
      expect(store.files).toHaveLength(2)
      expect(store.fileCount).toBe(2)
    })

    it('deduplicates by name', () => {
      const store = useFilesStore()
      store.addFiles([{ id: '1', name: 'a.csv', size: 100 }])
      store.addFiles([{ id: '2', name: 'a.csv', size: 200 }])
      expect(store.files).toHaveLength(1)
      expect(store.files[0].id).toBe('1')
    })

    it('allows different files with different names', () => {
      const store = useFilesStore()
      store.addFiles([{ id: '1', name: 'a.csv', size: 100 }])
      store.addFiles([{ id: '2', name: 'b.csv', size: 200 }])
      expect(store.files).toHaveLength(2)
    })

    it('handles empty array', () => {
      const store = useFilesStore()
      store.addFiles([])
      expect(store.files).toHaveLength(0)
    })

    it('adds multiple files in single call', () => {
      const store = useFilesStore()
      store.addFiles([
        { id: '1', name: 'a.csv', size: 100 },
        { id: '2', name: 'b.csv', size: 200 },
        { id: '3', name: 'c.csv', size: 300 }
      ])
      expect(store.fileCount).toBe(3)
    })
  })

  describe('removeFile', () => {
    it('removes file by id', () => {
      const store = useFilesStore()
      store.addFiles([
        { id: '1', name: 'a.csv', size: 100 },
        { id: '2', name: 'b.csv', size: 200 }
      ])
      store.removeFile('1')
      expect(store.files).toHaveLength(1)
      expect(store.files[0].name).toBe('b.csv')
    })

    it('also removes analysis for that file', () => {
      const store = useFilesStore()
      store.addFiles([{ id: '1', name: 'a.csv', size: 100 }])
      store.setAnalysis('1', makeAnalysis())
      expect(store.getAnalysis('1')).toBeDefined()

      store.removeFile('1')
      expect(store.getAnalysis('1')).toBeUndefined()
    })

    it('does nothing for non-existent id', () => {
      const store = useFilesStore()
      store.addFiles([{ id: '1', name: 'a.csv', size: 100 }])
      store.removeFile('non-existent')
      expect(store.files).toHaveLength(1)
    })
  })

  describe('setAnalysis / getAnalysis', () => {
    it('stores and retrieves analysis', () => {
      const store = useFilesStore()
      const analysis = makeAnalysis({ rowCount: 42 })
      store.setAnalysis('1', analysis)
      expect(store.getAnalysis('1')).toEqual(analysis)
    })

    it('returns undefined for non-existent file', () => {
      const store = useFilesStore()
      expect(store.getAnalysis('missing')).toBeUndefined()
    })

    it('overwrites existing analysis', () => {
      const store = useFilesStore()
      store.setAnalysis('1', makeAnalysis({ rowCount: 10 }))
      store.setAnalysis('1', makeAnalysis({ rowCount: 20 }))
      expect(store.getAnalysis('1')?.rowCount).toBe(20)
    })

    it('stores analysis with all fields', () => {
      const store = useFilesStore()
      const analysis = makeAnalysis({
        headers: ['id', 'name', 'email'],
        rowCount: 500,
        sampleRows: [
          { id: '1', name: 'Alice', email: 'a@b.com' },
          { id: '2', name: 'Bob', email: 'b@c.com' }
        ],
        delimiter: ';',
        hasIdColumn: true,
        hasDotIdColumn: false
      })
      store.setAnalysis('file1', analysis)
      const result = store.getAnalysis('file1')!
      expect(result.headers).toEqual(['id', 'name', 'email'])
      expect(result.rowCount).toBe(500)
      expect(result.sampleRows).toHaveLength(2)
      expect(result.delimiter).toBe(';')
      expect(result.hasIdColumn).toBe(true)
      expect(result.hasDotIdColumn).toBe(false)
    })
  })

  describe('clearAll', () => {
    it('removes all files and analyses', () => {
      const store = useFilesStore()
      store.addFiles([
        { id: '1', name: 'a.csv', size: 100 },
        { id: '2', name: 'b.csv', size: 200 }
      ])
      store.setAnalysis('1', makeAnalysis())
      store.setAnalysis('2', makeAnalysis())

      store.clearAll()

      expect(store.files).toHaveLength(0)
      expect(store.fileCount).toBe(0)
      expect(Object.keys(store.analyses).length).toBe(0)
    })

    it('is safe to call on empty store', () => {
      const store = useFilesStore()
      store.clearAll()
      expect(store.files).toHaveLength(0)
    })
  })

  describe('fileCount', () => {
    it('updates as files are added', () => {
      const store = useFilesStore()
      expect(store.fileCount).toBe(0)
      store.addFiles([{ id: '1', name: 'a.csv', size: 100 }])
      expect(store.fileCount).toBe(1)
      store.addFiles([{ id: '2', name: 'b.csv', size: 200 }])
      expect(store.fileCount).toBe(2)
    })

    it('updates as files are removed', () => {
      const store = useFilesStore()
      store.addFiles([
        { id: '1', name: 'a.csv', size: 100 },
        { id: '2', name: 'b.csv', size: 200 }
      ])
      expect(store.fileCount).toBe(2)
      store.removeFile('1')
      expect(store.fileCount).toBe(1)
    })
  })
})
