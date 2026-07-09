import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface FileHandle {
  id: string
  name: string
  size: number
}

export interface FileAnalysis {
  headers: string[]
  rowCount: number
  sampleRows: Record<string, string>[]
  delimiter: string
  hasIdColumn: boolean
  hasDotIdColumn: boolean
}

export const useFilesStore = defineStore('files', () => {
  const files = ref<FileHandle[]>([])
  const analyses = ref<Record<string, FileAnalysis>>({})

  const fileCount = computed(() => files.value.length)

  /**
   * Add files, de-duplicating by name (files are matched to mappings/sequence
   * by name everywhere). Returns the files that were dropped as duplicates so
   * the caller can warn — otherwise a second file with the same basename would
   * vanish silently.
   */
  function addFiles(newFiles: FileHandle[]): FileHandle[] {
    const duplicates: FileHandle[] = []
    for (const file of newFiles) {
      if (!files.value.find(f => f.name === file.name)) {
        files.value.push(file)
      } else {
        duplicates.push(file)
      }
    }
    return duplicates
  }

  function removeFile(id: string) {
    files.value = files.value.filter(f => f.id !== id)
    const { [id]: _, ...rest } = analyses.value
    analyses.value = rest
  }

  function setAnalysis(fileId: string, analysis: FileAnalysis) {
    analyses.value = { ...analyses.value, [fileId]: analysis }
  }

  function getAnalysis(fileId: string): FileAnalysis | undefined {
    return analyses.value[fileId]
  }

  function clearAll() {
    files.value = []
    analyses.value = {}
    // Release file handles in Electron to prevent locked files on Windows
    window.api?.files?.cleanupStreams?.()
  }

  return {
    files,
    analyses,
    fileCount,
    addFiles,
    removeFile,
    setAnalysis,
    getAnalysis,
    clearAll
  }
})
