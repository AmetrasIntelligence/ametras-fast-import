/**
 * Odoo-embedded implementation of window.api (ElectronAPI).
 * Replaces Electron IPC with same-origin fetch calls to Odoo controllers.
 */

// Temp storage for File objects from drag-and-drop
const _fileMap = new Map<string, File>()

let _idCounter = 0
function nextEmbeddedId(): string {
  return `embedded:${++_idCounter}`
}

/**
 * JSON-RPC call to an Odoo controller (type='json').
 */
async function jsonRpc<T = unknown>(endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
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
  })
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
        const { stream_id } = await jsonRpc<{ stream_id: string }>(
          '/ametras_fast_import/file/stream_start',
          { file_id: id, chunk_lines: chunkLines },
        )
        let done = false
        while (!done) {
          const chunk = await jsonRpc<{ data: string; done: boolean; error?: string }>(
            '/ametras_fast_import/file/stream_next',
            { stream_id },
          )
          onChunk(chunk)
          done = chunk.done
        }
        await jsonRpc('/ametras_fast_import/file/stream_close', { stream_id })
      },

      streamStart: async (id, chunkLines, encoding) => {
        const params: Record<string, unknown> = { file_id: id, chunk_lines: chunkLines }
        if (encoding) params.encoding = encoding
        const result = await jsonRpc<{ stream_id: string; error?: string }>(
          '/ametras_fast_import/file/stream_start',
          params,
        )
        if (result.error) throw new Error(result.error)
        return result.stream_id
      },

      streamNext: async (streamId) => {
        return await jsonRpc<{ data: string; done: boolean; error?: string }>(
          '/ametras_fast_import/file/stream_next',
          { stream_id: streamId },
        )
      },

      streamClose: async (streamId) => {
        await jsonRpc('/ametras_fast_import/file/stream_close', { stream_id: streamId })
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
          const data = await response.json()
          if (data.error) {
            return {
              ok: false as const,
              error: data.error.data?.message || data.error.message || 'RPC Error',
            }
          }
          return { ok: true as const, result: data.result }
        } catch (e) {
          return {
            ok: false as const,
            error: e instanceof Error ? e.message : 'Request failed',
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
          return true
        } catch {
          return false
        }
      },
    },

    // standalone code flag (do not remove comment)
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
