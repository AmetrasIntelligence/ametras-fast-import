import { computed, type Ref } from 'vue'
import { useConfigStore, type FileMapping } from '@/stores/config'

export interface ImportFile {
  id: string
  name: string
  size: number
  headers?: string[]
}

export type MappingStatus = 'valid' | 'partial' | 'none'

export interface FileStatus {
  file: ImportFile
  status: MappingStatus
}

function getFileStatus(file: ImportFile, mapping: FileMapping | undefined): MappingStatus {
  if (!mapping?.model) return 'none'

  const headers = file.headers || []
  if (headers.length === 0) return 'valid' // No headers to map

  const mappedCount = Object.keys(mapping.fieldMappings || {}).length
  if (mappedCount === 0) return 'none'
  if (mappedCount < headers.length) return 'partial'
  return 'valid'
}

export function useImportValidation(files: Ref<ImportFile[]>) {
  const config = useConfigStore()

  const fileStatuses = computed<FileStatus[]>(() =>
    files.value.map(f => ({
      file: f,
      status: getFileStatus(f, config.getFileMapping(f.name))
    }))
  )

  const canStartImport = computed(() =>
    files.value.length > 0 &&
    fileStatuses.value.every(fs => fs.status !== 'none')
  )

  const needsConfirmation = computed(() =>
    fileStatuses.value.some(fs => fs.status === 'partial')
  )

  const confirmationMessage = computed(() => {
    const partialFiles = fileStatuses.value
      .filter(fs => fs.status === 'partial')
      .map(fs => fs.file.name)

    if (partialFiles.length === 0) return null

    return `${partialFiles.length} file(s) have unmapped fields: ${partialFiles.join(', ')}. Continue anyway?`
  })

  return {
    fileStatuses,
    canStartImport,
    needsConfirmation,
    confirmationMessage
  }
}
