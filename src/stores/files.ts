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
  const analyses = ref<Map<string, FileAnalysis>>(new Map())

  const fileCount = computed(() => files.value.length)

  function addFiles(newFiles: FileHandle[]) {
    for (const file of newFiles) {
      if (!files.value.find(f => f.name === file.name)) {
        files.value.push(file)
      }
    }
  }

  function removeFile(id: string) {
    files.value = files.value.filter(f => f.id !== id)
    // Create new Map to ensure Vue reactivity triggers
    const newMap = new Map(analyses.value)
    newMap.delete(id)
    analyses.value = newMap
  }

  function setAnalysis(fileId: string, analysis: FileAnalysis) {
    // Create new Map to ensure Vue reactivity triggers
    const newMap = new Map(analyses.value)
    newMap.set(fileId, analysis)
    analyses.value = newMap
  }

  function getAnalysis(fileId: string): FileAnalysis | undefined {
    return analyses.value.get(fileId)
  }

  function clearAll() {
    files.value = []
    analyses.value.clear()
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
