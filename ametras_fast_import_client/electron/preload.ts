const { contextBridge, ipcRenderer, webUtils } = require('electron')

interface ProfileUploadResult {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

interface StandaloneLoadParams {
  baseUrl: string
  db: string
  model: string
  header: string[]
  rows: (string | number | boolean | null)[][]
}

interface StandaloneLoadResult {
  ok: boolean
  ids?: number[]
  messages?: Array<{
    type: string
    message: string
    record?: number
    field?: string
  }>
  error?: string
  errorCode?: 'NETWORK_ERROR' | 'TIMEOUT' | 'DATA_ERROR' | 'CONCURRENCY_ERROR' | 'AUTH_ERROR' | 'UNKNOWN'
}

interface StandaloneDetectResult {
  available: boolean
  version?: string
  odooVersion?: string
  error?: string
}

interface ElectronAPI {
  files: {
    select: () => Promise<FileHandle[]>
    register: (paths: string[]) => Promise<FileHandle[]>
    read: (id: string, encoding?: string) => Promise<string>
    readHead: (id: string, bytes: number, encoding?: string) => Promise<string>
    countLines: (id: string) => Promise<number>
    streamChunks: (id: string, chunkLines: number, onChunk: (chunk: ChunkData) => void, encoding?: string) => Promise<void>
    // Async streaming with backpressure support
    streamStart: (id: string, chunkLines: number, encoding?: string) => Promise<string>
    streamNext: (streamId: string) => Promise<ChunkData>
    streamClose: (streamId: string) => Promise<void>
    getPathForFile: (file: File) => string
  }
  odoo: {
    call: <T>(payload: OdooPayload) => Promise<OdooCallResult<T>>
    authenticate: (params: AuthParams) => Promise<AuthResult>
    listDatabases: (baseUrl: string) => Promise<DatabaseListResult>
    ping: (baseUrl: string) => Promise<{ ok: boolean }>
    getEncryptionInfo: () => Promise<{ available: boolean; platform: string }>
    pinSession: (payload: { baseUrl: string; db?: string; pinned: boolean }) => Promise<{ ok: boolean; error?: string }>
  }
  store: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  profile: {
    selectZip: () => Promise<{ path: string; name: string } | null>
    upload: (payload: { baseUrl: string; db?: string; filePath: string }) => Promise<ProfileUploadResult>
    export: (payload: { baseUrl: string; db?: string; profileId: number; profileName: string }) => Promise<{ ok: boolean; error?: string }>
  }
  standalone: {
    detectAddon: (payload: { baseUrl: string; db: string }) => Promise<StandaloneDetectResult>
    load: (payload: StandaloneLoadParams) => Promise<StandaloneLoadResult>
    getOdooVersion: (payload: { baseUrl: string; db: string }) => Promise<{ version: string | null; error?: string }>
  }
}

interface FileHandle {
  id: string
  name: string
  size: number
}

interface ChunkData {
  data: string
  done: boolean
  error?: string
}

interface OdooPayload {
  baseUrl: string
  db?: string
  endpoint: string
  params: Record<string, unknown>
}

interface AuthParams {
  baseUrl: string
  db: string
  login: string
  password: string
}

interface AuthResult {
  ok: boolean
  uid?: number
  session_id?: string
  server_version?: string
  error?: string
}

interface DatabaseListResult {
  ok: boolean
  databases: string[]
  error?: string
}

interface OdooCallResult<T> {
  ok: boolean
  result?: T
  error?: string
  errorCode?: 'NETWORK_ERROR' | 'TIMEOUT' | 'DATA_ERROR' | 'AUTH_ERROR' | 'UNKNOWN'
}

contextBridge.exposeInMainWorld('api', {
  files: {
    select: () => ipcRenderer.invoke('files:select'),
    register: (paths: string[]) => ipcRenderer.invoke('files:register', paths),
    read: (id: string, encoding?: string) => ipcRenderer.invoke('files:read', id, encoding),
    readHead: (id: string, bytes: number, encoding?: string) => ipcRenderer.invoke('files:readHead', id, bytes, encoding),
    countLines: (id: string) => ipcRenderer.invoke('files:countLines', id),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    streamChunks: async (id: string, chunkLines: number, onChunk: (chunk: ChunkData) => void, encoding?: string) => {
      const streamId = await ipcRenderer.invoke('files:streamChunks', id, chunkLines, encoding)

      return new Promise<void>((resolve, reject) => {
        const handler = (_event: unknown, chunk: ChunkData) => {
          onChunk(chunk)
          if (chunk.done) {
            ipcRenderer.removeListener(`files:chunk:${streamId}`, handler)
            if (chunk.error) {
              reject(new Error(chunk.error))
            } else {
              resolve()
            }
          }
        }
        ipcRenderer.on(`files:chunk:${streamId}`, handler)
      })
    },
    // Async streaming with backpressure - allows awaiting each batch
    streamStart: (id: string, chunkLines: number, encoding?: string) =>
      ipcRenderer.invoke('files:streamStart', id, chunkLines, encoding),
    streamNext: (streamId: string) =>
      ipcRenderer.invoke('files:streamNext', streamId),
    streamClose: (streamId: string) =>
      ipcRenderer.invoke('files:streamClose', streamId)
  },
  odoo: {
    call: (payload: OdooPayload) => ipcRenderer.invoke('odoo:call', payload),
    authenticate: (params: AuthParams) => ipcRenderer.invoke('odoo:authenticate', params),
    listDatabases: (baseUrl: string) => ipcRenderer.invoke('odoo:listDatabases', baseUrl),
    ping: (baseUrl: string) => ipcRenderer.invoke('odoo:ping', baseUrl),
    getEncryptionInfo: () => ipcRenderer.invoke('odoo:getEncryptionInfo'),
    pinSession: (payload: { baseUrl: string; db?: string; pinned: boolean }) =>
      ipcRenderer.invoke('odoo:pinSession', payload)
  },
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value)
  },
  profile: {
    selectZip: () => ipcRenderer.invoke('profile:selectZip'),
    upload: (payload: { baseUrl: string; db?: string; filePath: string }) =>
      ipcRenderer.invoke('profile:upload', payload),
    export: (payload: { baseUrl: string; db?: string; profileId: number; profileName: string }) =>
      ipcRenderer.invoke('profile:export', payload)
  },
  standalone: {
    detectAddon: (payload: { baseUrl: string; db: string }) =>
      ipcRenderer.invoke('standalone:detectAddon', payload),
    load: (payload: StandaloneLoadParams) =>
      ipcRenderer.invoke('standalone:load', payload),
    getOdooVersion: (payload: { baseUrl: string; db: string }) =>
      ipcRenderer.invoke('standalone:getOdooVersion', payload)
  }
} as ElectronAPI)

declare global {
  interface Window {
    api: ElectronAPI
  }
}

export {}
