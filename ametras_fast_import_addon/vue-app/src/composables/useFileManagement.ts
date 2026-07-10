import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Papa from 'papaparse'
import { useFilesStore, type FileAnalysis, type FileHandle } from '@/stores/files'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { usePlatformStore } from '@/stores/platform'
import { useSavedMappingsStore } from '@/stores/savedMappings'
import { fetchModels, validateSampleRow, type OdooModel } from '@/api/odooClient'
import { suggestModel } from '@/utils/smartModelMapping'
import { autoMapFields } from '@/utils/smartFieldMapping'
import { showConfirm } from '@/utils/dialog'
import { logger } from '@/utils/logger'
import type { useFieldMetadata } from '@/composables/useFieldMetadata'

/** Per-file upload progress callbacks (matches window.api.files FileUploadProgress). */
interface IngestProgress {
  onStaged?: (files: { name: string; size: number }[]) => void
  onUploaded?: (handle: FileHandle) => void
  onError?: (name: string, error: string) => void
}

export function useFileManagement(fieldMeta: ReturnType<typeof useFieldMetadata>) {
  const { t } = useI18n()
  const filesStore = useFilesStore()
  const config = useConfigStore()
  const session = useSessionStore()
  const platform = usePlatformStore()
  const savedMappings = useSavedMappingsStore()

  const models = ref<OdooModel[]>([])
  const modelSuggestions = ref<Map<string, { model: OdooModel; score: number } | null>>(new Map())
  const fieldSuggestionsApplied = ref<Set<string>>(new Set())
  const loadError = ref<string | null>(null)
  const isAnalyzing = ref(false)
  const validationResults = ref<Map<string, { ok: boolean; message?: string; data?: Record<string, string | number> }>>(new Map())
  const validationTrigger = ref(0)

  function getValidationResult(filename: string) {
    void validationTrigger.value
    return validationResults.value.get(filename)
  }

  function getFileStatus(filename: string): 'valid' | 'partial' | 'none' {
    const mapping = config.getFileMapping(filename)
    if (!mapping?.model) return 'none'

    const file = filesStore.files.find(f => f.name === filename)
    const analysis = file ? filesStore.getAnalysis(file.id) : null
    if (!analysis?.headers) return 'valid'

    const mappedCount = Object.keys(mapping.fieldMappings || {}).length
    if (mappedCount === 0) return 'none'
    if (mappedCount < analysis.headers.length) return 'partial'
    return 'valid'
  }

  const canStartImport = computed(() =>
    filesStore.files.length > 0 &&
    filesStore.files.every(f => getFileStatus(f.name) !== 'none')
  )

  const hasPartialMappings = computed(() =>
    filesStore.files.some(f => getFileStatus(f.name) === 'partial')
  )

  function initMapping(filename: string) {
    if (!config.getFileMapping(filename)) {
      config.setFileMapping(filename, {
        filename,
        model: '',
        fieldMappings: {}
      })
    }
  }

  function generateSuggestion(filename: string, fileId: string) {
    const saved = savedMappings.findSuggestion(filename)
    if (saved) {
      const matchedModel = models.value.find(m => m.model === saved.model)
      if (matchedModel) {
        modelSuggestions.value.set(filename, { model: matchedModel, score: 100 })
        return
      }
    }
    const analysis = filesStore.getAnalysis(fileId)
    const suggestion = suggestModel(filename, models.value, undefined, {
      headers: analysis?.headers
    })
    modelSuggestions.value.set(filename, suggestion)
  }

  async function loadInitialData() {
    loadError.value = null
    try {
      models.value = await fetchModels()
      await savedMappings.load()
    } catch (e) {
      loadError.value = t('config.failedToLoadModels', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function restoreExistingFiles() {
    for (const file of filesStore.files) {
      initMapping(file.name)

      const existingMapping = config.getFileMapping(file.name)
      if (existingMapping?.model) {
        try {
          await fieldMeta.ensureFieldsCached(existingMapping.model)
        } catch {
          // Ignore, user can re-select model
        }
      }

      generateSuggestion(file.name, file.id)
    }
  }

  /**
   * Run the analysis chain for one uploaded file: Python engine → PapaParse
   * (Electron) → Odoo endpoint. Never throws — returns an empty analysis if
   * every path fails, which the caller treats as an error state.
   */
  async function runAnalysis(fileId: string): Promise<FileAnalysis> {
    let analysis: FileAnalysis = {
      headers: [], rowCount: 0, sampleRows: [], delimiter: ',', hasIdColumn: false, hasDotIdColumn: false,
    }

    if (window.api?.python?.analyze) {
      try {
        const pyResp = await window.api.python.analyze({
          fileId,
          encoding: config.settings.encoding || 'utf-8',
        }) as { ok: boolean; result?: Record<string, unknown>; error?: string }
        if (pyResp.ok && pyResp.result) {
          const r = pyResp.result as Record<string, unknown>
          if (r.type === 'analysis' && Array.isArray(r.headers) && (r.headers as string[]).length > 0) {
            analysis = {
              headers: r.headers as string[],
              rowCount: (r.rowCount as number) || 0,
              sampleRows: (r.sampleRows as Record<string, string>[]) || [],
              delimiter: (r.delimiter as string) || ',',
              hasIdColumn: !!(r.hasIdColumn),
              hasDotIdColumn: !!(r.hasDotIdColumn),
            }
          }
        }
      } catch {
        // Fall through to next fallback
      }
    }

    // JS fallback for Electron: use files IPC + PapaParse when Python is unavailable
    if (analysis.headers.length === 0 && window.api?.files?.readHead && window.api?.files?.countLines) {
      try {
        const encoding = config.settings.encoding || 'utf-8'
        const sample = await window.api.files.readHead(fileId, 65536, encoding)
        const parsed = Papa.parse<Record<string, string>>(sample, {
          header: true,
          skipEmptyLines: true,
          preview: 6,
        })
        const headers = parsed.meta.fields || []
        if (headers.length > 0) {
          const lineCount = await window.api.files.countLines(fileId)
          analysis = {
            headers,
            rowCount: Math.max(0, lineCount - 1),
            sampleRows: parsed.data.slice(0, 5),
            delimiter: parsed.meta.delimiter || ',',
            hasIdColumn: headers.includes('id'),
            hasDotIdColumn: headers.some(h => h.endsWith('.id')),
          }
        }
      } catch {
        // Fall through to Odoo endpoint
      }
    }

    if (analysis.headers.length === 0) {
      const analyzeResp = await window.api.odoo.call<FileAnalysis>({
        baseUrl: '',
        endpoint: '/ametras_fast_import/file/analyze',
        params: { file_id: fileId, encoding: config.settings.encoding || 'utf-8' }
      })
      if (analyzeResp.ok && analyzeResp.result) {
        analysis = analyzeResp.result
      }
    }

    return analysis
  }

  /** Analyze one uploaded file, driving its status analyzing → ready | error. */
  async function analyzeHandle(handle: FileHandle) {
    filesStore.setStatus(handle.id, 'analyzing')
    const analysis = await runAnalysis(handle.id)
    filesStore.setAnalysis(handle.id, analysis)
    if (analysis.headers.length === 0) {
      // Every analysis path failed — empty/unreadable file or wrong encoding.
      const message = t('files.analyzeFailed')
      filesStore.setStatus(handle.id, 'error', message)
      logger.import.warn(`Could not analyze "${handle.name}" (no columns detected).`)
    } else {
      filesStore.setStatus(handle.id, 'ready')
    }
    initMapping(handle.name)
    generateSuggestion(handle.name, handle.id)
  }

  /**
   * Ingest picked files with per-file progress. When the API reports progress
   * (Odoo-embedded: files upload one-by-one), each file shows uploading →
   * analyzing → ready and upload errors are surfaced per file. Otherwise
   * (Electron: local files) it falls back to adding the returned handles and
   * analyzing them directly.
   */
  async function ingest(pick: (progress: IngestProgress) => Promise<FileHandle[]>) {
    isAnalyzing.value = true
    const analyses: Promise<void>[] = []
    let usedProgress = false
    try {
      const handles = await pick({
        onStaged: (staged) => {
          usedProgress = true
          for (const s of staged) {
            if (filesStore.files.find(f => f.name === s.name)) continue
            const id = `staging:${s.name}`
            filesStore.addFiles([{ id, name: s.name, size: s.size }])
            filesStore.setStatus(id, 'uploading')
          }
          config.setSequence(filesStore.files.map(f => f.name))
        },
        onUploaded: (handle) => {
          usedProgress = true
          const stagingId = `staging:${handle.name}`
          const hadPlaceholder = filesStore.files.some(f => f.id === stagingId)
          if (!hadPlaceholder && filesStore.files.some(f => f.name === handle.name)) {
            logger.import.warn(`Ignored duplicate file "${handle.name}" (matched by name).`)
            return
          }
          filesStore.replaceFile(stagingId, handle)
          config.setSequence(filesStore.files.map(f => f.name))
          analyses.push(analyzeHandle(handle))
        },
        onError: (name, error) => {
          usedProgress = true
          filesStore.setStatus(`staging:${name}`, 'error', error)
          logger.import.error(`Upload failed for "${name}": ${error}`)
        },
      })

      if (!usedProgress) {
        // No per-file progress (Electron/standalone): add + analyze directly.
        const duplicates = filesStore.addFiles(handles)
        if (duplicates.length > 0) {
          logger.import.warn(
            `Ignored ${duplicates.length} file(s) already in the list (matched by name): ` +
            `${duplicates.map(f => f.name).join(', ')}. Rename to import both.`,
          )
        }
        const dupIds = new Set(duplicates.map(f => f.id))
        for (const handle of handles) {
          if (dupIds.has(handle.id)) continue
          filesStore.setStatus(handle.id, 'analyzing')
          analyses.push(analyzeHandle(handle))
        }
        config.setSequence(filesStore.files.map(f => f.name))
      }

      await Promise.all(analyses)
    } finally {
      isAnalyzing.value = false
    }
  }

  async function selectFiles() {
    await ingest(progress => window.api.files.select(progress))
  }

  /** Back-compat wrapper: analyze an already-uploaded set of handles. */
  async function addFilesAndAnalyze(selected: FileHandle[]) {
    await ingest(async () => selected)
  }

  async function handleDrop(files: File[]) {
    const paths = files
      .map(f => {
        try {
          return window.api.files.getPathForFile(f)
        } catch {
          return null
        }
      })
      .filter((p): p is string => !!p)

    if (paths.length === 0) {
      selectFiles()
      return
    }

    await ingest(progress => window.api.files.register(paths, progress))
  }

  async function selectModelForFile(filename: string, model: string) {
    fieldSuggestionsApplied.value.delete(filename)

    const mapping = config.getFileMapping(filename)
    if (mapping) {
      config.setFileMapping(filename, { ...mapping, model, fieldMappings: {} })
    }

    await fieldMeta.ensureFieldsCached(model)

    const file = filesStore.files.find(f => f.name === filename)
    const analysis = file ? filesStore.getAnalysis(file.id) : null
    const fields = fieldMeta.fieldsCache.value.get(model)
    if (analysis && fields && !fieldSuggestionsApplied.value.has(filename)) {
      const suggestions = autoMapFields(analysis.headers, fields)
      if (Object.keys(suggestions).length > 0 && mapping) {
        config.setFileMapping(filename, { ...mapping, model, fieldMappings: suggestions })
        fieldSuggestionsApplied.value.add(filename)
      }
    }

    savedMappings.addMapping(filename, model)
  }

  function removeFile(fileId: string) {
    const file = filesStore.files.find(f => f.id === fileId)
    const filename = file?.name

    filesStore.removeFile(fileId)
    config.setSequence(
      filename
        ? config.importSequence.filter(f => f !== filename)
        : filesStore.files.map(f => f.name)
    )

    if (filename) {
      config.removeFileMapping(filename)
      fieldMeta.clearForFile(filename)

      if (validationResults.value.has(filename)) {
        validationResults.value.delete(filename)
        validationTrigger.value++
      }

      modelSuggestions.value.delete(filename)
      fieldSuggestionsApplied.value.delete(filename)
    }
  }

  async function removeAllFiles() {
    const confirmed = await showConfirm(t('files.removeAllConfirm'))
    if (!confirmed) return

    filesStore.clearAll()
    config.clearFileMappings()
    config.setSequence([])
    fieldMeta.clearAll()
    modelSuggestions.value = new Map()
    fieldSuggestionsApplied.value = new Set()
    validationResults.value = new Map()
    validationTrigger.value++
  }

  function handleReorder(filenames: string[]) {
    config.setSequence(filenames)
  }

  function toggleStrictForFile(filename: string, strict: boolean) {
    const mapping = config.getFileMapping(filename)
    if (mapping) {
      config.setFileMapping(filename, { ...mapping, strict })
    }
  }

  async function validateRowForFile(filename: string) {
    const mapping = config.getFileMapping(filename)
    const file = filesStore.files.find(f => f.name === filename)
    const analysis = file ? filesStore.getAnalysis(file.id) : null

    if (!mapping?.model || !analysis?.sampleRows?.length || !session.baseUrl) return

    validatingFile.value = filename
    validationResults.value.delete(filename)
    validationTrigger.value++

    try {
      const randomIndex = Math.floor(Math.random() * analysis.sampleRows.length)
      const row = analysis.sampleRows[randomIndex]
      const rowNum = randomIndex + 2

      const result = await validateSampleRow(
        mapping.model, row, mapping.fieldMappings,
        platform.capabilities.dryRun,
      )

      validationResults.value.set(filename, {
        ok: result.ok,
        message: result.ok
          ? t('config.validationRowSuccess', { row: rowNum, action: result.action || 'processed' })
          : t('config.validationRowError', { row: rowNum, error: result.message || t('config.validationFailed') }),
        data: row,
      })
    } catch (e) {
      validationResults.value.set(filename, {
        ok: false,
        message: e instanceof Error ? e.message : t('config.validationFailed'),
      })
    } finally {
      validatingFile.value = null
      validationTrigger.value++
    }
  }

  const validatingFile = ref<string | null>(null)

  return {
    modelSuggestions,
    loadError,
    isAnalyzing,
    validatingFile,
    canStartImport,
    hasPartialMappings,
    getValidationResult,
    getFileStatus,
    loadInitialData,
    restoreExistingFiles,
    selectFiles,
    addFilesAndAnalyze,
    handleDrop,
    selectModelForFile,
    removeFile,
    removeAllFiles,
    handleReorder,
    toggleStrictForFile,
    validateRowForFile,
  }
}
