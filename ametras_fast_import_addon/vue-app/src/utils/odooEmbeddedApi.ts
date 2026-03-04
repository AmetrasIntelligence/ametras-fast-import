/**
 * Odoo-embedded implementation of window.api (ElectronAPI).
 * Replaces Electron IPC with same-origin fetch calls to Odoo controllers.
 */
import { classifyFetchError, ImportErrorCode } from '@/utils/errors'

// Temp storage for File objects from drag-and-drop
const _fileMap = new Map<string, File>()

// Client-side stream state for stateless chunk endpoint
const _streamState = new Map<string, {
  fileId: string; chunkLines: number; encoding?: string; offset: number
}>()

let _idCounter = 0
function nextEmbeddedId(): string {
  return `embedded:${++_idCounter}`
}

/**
 * JSON-RPC call to an Odoo controller (type='json').
 */
async function jsonRpc<T = unknown>(
  endpoint: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params,
      id: Date.now(),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  const data = await response.json()
  if (data.error) {
    throw new Error(data.error.data?.message || data.error.message || 'RPC Error')
  }
  return data.result as T
}

/**
 * Upload a File object to Odoo via multipart POST.
 */
async function uploadFile(file: File) {
  const formData = new FormData()
  formData.append('file', file, file.name)

  const response = await fetch('/ametras_fast_import/file/upload', {
    method: 'POST',
    credentials: 'same-origin',
    body: formData,
  })
  const result = await response.json()
  if (result.error) {
    throw new Error(result.error)
  }
  return {
    id: String(result.id),
    name: result.name as string,
    size: result.size as number,
  }
}

/**
 * Open a browser file picker.
 */
function openFilePicker(accept?: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.multiple = multiple
    input.onchange = () => {
      const files = input.files ? Array.from(input.files) : []
      resolve(files)
    }
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}

export function installOdooEmbeddedApi(): void {
  window.api = {
    files: {
      select: async () => {
        const files = await openFilePicker('.csv,.txt,.tsv')
        const handles = []
        for (const file of files) {
          handles.push(await uploadFile(file))
        }
        return handles
      },

      register: async (paths) => {
        const handles = []
        for (const path of paths) {
          const file = _fileMap.get(path)
          if (file) {
            handles.push(await uploadFile(file))
            _fileMap.delete(path)
          }
        }
        return handles
      },

      read: async (id) => {
        const result = await jsonRpc<{ content: string; error?: string }>(
          '/ametras_fast_import/file/read',
          { file_id: id },
        )
        if (result.error) throw new Error(result.error)
        return result.content
      },

      readHead: async (id, bytes) => {
        const result = await jsonRpc<{ content: string; error?: string }>(
          '/ametras_fast_import/file/read_head',
          { file_id: id, bytes },
        )
        if (result.error) throw new Error(result.error)
        return result.content
      },

      countLines: async (id) => {
        const result = await jsonRpc<{ count: number; error?: string }>(
          '/ametras_fast_import/file/count_lines',
          { file_id: id },
        )
        if (result.error) throw new Error(result.error)
        return result.count
      },

      streamChunks: async (id, chunkLines, onChunk) => {
        let offset = 0
        let done = false
        while (!done) {
          const result = await jsonRpc<{ data: string; done: boolean; error?: string }>(
            '/ametras_fast_import/file/stream_chunk',
            { file_id: id, chunk_lines: chunkLines, offset },
          )
          onChunk({ data: result.data, done: result.done, error: result.error })
          done = result.done
          offset += chunkLines
        }
      },

      streamStart: async (id, chunkLines, encoding) => {
        const streamId = `local:${++_idCounter}`
        _streamState.set(streamId, { fileId: id, chunkLines, encoding, offset: 0 })
        return streamId
      },

      streamNext: async (streamId) => {
        const state = _streamState.get(streamId)
        if (!state) return { data: '', done: true, error: 'Stream not found' }
        const result = await jsonRpc<{ data: string; done: boolean; error?: string }>(
          '/ametras_fast_import/file/stream_chunk',
          {
            file_id: state.fileId,
            chunk_lines: state.chunkLines,
            offset: state.offset,
            encoding: state.encoding,
          },
        )
        state.offset += state.chunkLines
        if (result.done) _streamState.delete(streamId)
        return { data: result.data, done: result.done, error: result.error }
      },

      streamClose: async (streamId) => {
        _streamState.delete(streamId)
      },

      getPathForFile: (file) => {
        const id = nextEmbeddedId()
        _fileMap.set(id, file)
        return id
      },
    },

    odoo: {
      call: async (payload) => {
        try {
          const response = await fetch(payload.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'call',
              params: payload.params,
              id: Date.now(),
            }),
          })

          // Check HTTP-level errors before parsing JSON
          if (!response.ok) {
            const status = response.status
            if (status === 429) {
              return {
                ok: false as const,
                error: `HTTP ${status}: Too many requests`,
                errorCode: 'NETWORK_ERROR' as const,
              }
            }
            if (status === 500) {
              return {
                ok: false as const,
                error: `HTTP ${status}: Internal server error`,
                errorCode: 'NETWORK_ERROR' as const,
              }
            }
            if (status === 502 || status === 503 || status === 504) {
              return {
                ok: false as const,
                error: `HTTP ${status}: Server unavailable`,
                errorCode: 'NETWORK_ERROR' as const,
              }
            }
            return {
              ok: false as const,
              error: `HTTP ${status}: ${response.statusText}`,
              errorCode: 'UNKNOWN' as const,
            }
          }

          const data = await response.json()
          if (data.error) {
            return {
              ok: false as const,
              error: data.error.data?.message || data.error.message || 'RPC Error',
              errorCode: 'DATA_ERROR' as const,
            }
          }
          return { ok: true as const, result: data.result }
        } catch (e) {
          const code = classifyFetchError(e)
          const errorCode: 'NETWORK_ERROR' | 'TIMEOUT' | 'UNKNOWN' =
            code === ImportErrorCode.NETWORK_ERROR ? 'NETWORK_ERROR'
            : code === ImportErrorCode.TIMEOUT ? 'TIMEOUT'
            : 'UNKNOWN'
          return {
            ok: false as const,
            error: e instanceof Error ? e.message : 'Request failed',
            errorCode,
          }
        }
      },

      authenticate: async () => {
        // Already authenticated in Odoo session — no-op
        return { ok: true as const, uid: 0, session_id: '', server_version: '' }
      },

      listDatabases: async () => {
        // Not needed in embedded mode
        return { ok: true as const, databases: [] as string[] }
      },

      ping: async () => {
        // Embedded mode: same-origin fetch to check server reachability
        try {
          const response = await fetch('/web/webclient/version_info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {}, id: Date.now() }),
            signal: AbortSignal.timeout(5000),
          })
          return { ok: response.ok }
        } catch {
          return { ok: false }
        }
      },
    },

    store: {
      get: async (key) => {
        const raw = localStorage.getItem(`csv-import-embedded-${key}`)
        if (raw === null) return null
        try {
          return JSON.parse(raw)
        } catch {
          return null
        }
      },

      set: async (key, value) => {
        localStorage.setItem(`csv-import-embedded-${key}`, JSON.stringify(value))
      },
    },

    profile: {
      selectZip: async () => {
        const files = await openFilePicker('.zip', false)
        if (files.length === 0) return null
        const file = files[0]
        const id = nextEmbeddedId()
        _fileMap.set(id, file)
        return { path: id, name: file.name }
      },

      upload: async (payload) => {
        const file = _fileMap.get(payload.filePath)
        if (!file) {
          return { ok: false as const, error: 'File not found' }
        }

        const formData = new FormData()
        formData.append('file', file, file.name)

        try {
          const response = await fetch('/ametras_fast_import/profile/upload', {
            method: 'POST',
            credentials: 'same-origin',
            body: formData,
          })
          const data = await response.json()
          if (data.error) {
            return { ok: false as const, error: data.error }
          }
          _fileMap.delete(payload.filePath)
          return { ok: true as const, result: data.result || data }
        } catch (e) {
          return {
            ok: false as const,
            error: e instanceof Error ? e.message : 'Upload failed',
          }
        }
      },

      export: async (payload) => {
        try {
          const url = `/ametras_fast_import/profile/${payload.profileId}/export`
          const link = document.createElement('a')
          link.href = url
          link.download = `${payload.profileName}.zip`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          return { ok: true }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : 'Export failed' }
        }
      },
    },

  
    standalone: {
      detectAddon: async () => {
        // Addon is always available in embedded mode
        return { available: true }
      },

      load: async () => {
        return { ok: false as const, error: 'Not available in embedded mode' }
      },

      getOdooVersion: async () => {
        return { version: null }
      },
    },
  }
}
