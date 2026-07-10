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

/** Lifecycle state of a file from selection through to ready-to-import. */
export type FileStatus = 'uploading' | 'analyzing' | 'ready' | 'error'

export interface FileState {
  status: FileStatus
  error?: string
}

export const useFilesStore = defineStore('files', () => {
  const files = ref<FileHandle[]>([])
  const analyses = ref<Record<string, FileAnalysis>>({})
  const statuses = ref<Record<string, FileState>>({})

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
    const { [id]: _a, ...restAnalyses } = analyses.value
    analyses.value = restAnalyses
    const { [id]: _s, ...restStatuses } = statuses.value
    statuses.value = restStatuses
  }

  /**
   * Replace a (staging placeholder) file with its real, uploaded handle,
   * carrying its status over to the new id. Used by the upload flow so a file
   * shown as "uploading" seamlessly becomes the real, analyzable file.
   */
  function replaceFile(oldId: string, handle: FileHandle) {
    const idx = files.value.findIndex(f => f.id === oldId)
    if (idx === -1) {
      if (!files.value.find(f => f.id === handle.id)) files.value.push(handle)
    } else {
      files.value.splice(idx, 1, handle)
    }
    const prev = statuses.value[oldId]
    const { [oldId]: _s, ...restStatuses } = statuses.value
    statuses.value = { ...restStatuses, [handle.id]: prev ?? { status: 'ready' } }
    if (oldId !== handle.id && analyses.value[oldId]) {
      const { [oldId]: moved, ...restAnalyses } = analyses.value
      analyses.value = { ...restAnalyses, [handle.id]: moved }
    }
  }

  function setAnalysis(fileId: string, analysis: FileAnalysis) {
    analyses.value = { ...analyses.value, [fileId]: analysis }
  }

  function getAnalysis(fileId: string): FileAnalysis | undefined {
    return analyses.value[fileId]
  }

  function setStatus(fileId: string, status: FileStatus, error?: string) {
    statuses.value = { ...statuses.value, [fileId]: { status, error } }
  }

  function getStatus(fileId: string): FileState | undefined {
    return statuses.value[fileId]
  }

  function clearAll() {
    files.value = []
    analyses.value = {}
    statuses.value = {}
    // Release file handles in Electron to prevent locked files on Windows
    window.api?.files?.cleanupStreams?.()
  }

  return {
    files,
    analyses,
    statuses,
    fileCount,
    addFiles,
    removeFile,
    replaceFile,
    setAnalysis,
    getAnalysis,
    setStatus,
    getStatus,
    clearAll
  }
})
