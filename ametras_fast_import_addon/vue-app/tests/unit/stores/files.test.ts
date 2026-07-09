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
    it('starts empty', () => {
      const store = useFilesStore()
      expect(store.files).toEqual([])
      expect(store.fileCount).toBe(0)
      expect(Object.keys(store.analyses).length).toBe(0)
    })
  })

  describe('addFiles', () => {
    it('adds files, deduplicates by name, and handles edge cases', () => {
      const store = useFilesStore()

      store.addFiles([
        { id: '1', name: 'a.csv', size: 100 },
        { id: '2', name: 'b.csv', size: 200 }
      ])
      expect(store.files).toHaveLength(2)
      expect(store.fileCount).toBe(2)

      // Dedup
      store.addFiles([{ id: '3', name: 'a.csv', size: 300 }])
      expect(store.files).toHaveLength(2)
      expect(store.files[0].id).toBe('1')

      // Different name is fine
      store.addFiles([{ id: '4', name: 'c.csv', size: 400 }])
      expect(store.files).toHaveLength(3)
    })

    it('handles empty array', () => {
      const store = useFilesStore()
      store.addFiles([])
      expect(store.files).toHaveLength(0)
    })

    it('returns the dropped duplicates so the caller can warn', () => {
      const store = useFilesStore()
      store.addFiles([{ id: '1', name: 'a.csv', size: 100 }])

      // Same-named file from a different path is dropped and reported.
      const dups = store.addFiles([
        { id: '2', name: 'a.csv', size: 999 },
        { id: '3', name: 'b.csv', size: 200 }
      ])
      expect(store.files.map(f => f.name)).toEqual(['a.csv', 'b.csv'])
      expect(store.files.find(f => f.name === 'a.csv')?.id).toBe('1')
      expect(dups.map(f => f.id)).toEqual(['2'])

      // Duplicates within a single call are reported too.
      const dups2 = store.addFiles([
        { id: '4', name: 'x.csv', size: 1 },
        { id: '5', name: 'x.csv', size: 1 }
      ])
      expect(dups2.map(f => f.id)).toEqual(['5'])

      // No duplicates → empty array.
      expect(store.addFiles([{ id: '6', name: 'z.csv', size: 1 }])).toEqual([])
    })
  })

  describe('removeFile', () => {
    it('removes by id and cleans up analysis', () => {
      const store = useFilesStore()
      store.addFiles([
        { id: '1', name: 'a.csv', size: 100 },
        { id: '2', name: 'b.csv', size: 200 }
      ])
      store.setAnalysis('1', makeAnalysis())

      store.removeFile('1')
      expect(store.files).toHaveLength(1)
      expect(store.files[0].name).toBe('b.csv')
      expect(store.getAnalysis('1')).toBeUndefined()

      // Non-existent id is a no-op
      store.removeFile('non-existent')
      expect(store.files).toHaveLength(1)
    })
  })

  describe('setAnalysis / getAnalysis', () => {
    it('stores, retrieves, overwrites, and returns undefined for missing', () => {
      const store = useFilesStore()

      store.setAnalysis('1', makeAnalysis({ rowCount: 42 }))
      expect(store.getAnalysis('1')?.rowCount).toBe(42)
      expect(store.getAnalysis('missing')).toBeUndefined()

      store.setAnalysis('1', makeAnalysis({ rowCount: 20 }))
      expect(store.getAnalysis('1')?.rowCount).toBe(20)

      const full = makeAnalysis({
        headers: ['id', 'name', 'email'],
        rowCount: 500,
        sampleRows: [{ id: '1', name: 'Alice', email: 'a@b.com' }, { id: '2', name: 'Bob', email: 'b@c.com' }],
        delimiter: ';',
        hasIdColumn: true,
        hasDotIdColumn: false
      })
      store.setAnalysis('file1', full)
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

      store.clearAll()

      expect(store.files).toHaveLength(0)
      expect(store.fileCount).toBe(0)
      expect(Object.keys(store.analyses).length).toBe(0)

      // Safe on empty
      store.clearAll()
      expect(store.files).toHaveLength(0)
    })
  })

  describe('fileCount', () => {
    it('updates as files are added and removed', () => {
      const store = useFilesStore()
      expect(store.fileCount).toBe(0)
      store.addFiles([{ id: '1', name: 'a.csv', size: 100 }])
      expect(store.fileCount).toBe(1)
      store.addFiles([{ id: '2', name: 'b.csv', size: 200 }])
      expect(store.fileCount).toBe(2)
      store.removeFile('1')
      expect(store.fileCount).toBe(1)
    })
  })
})
