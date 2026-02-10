import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface ProfileUploadResult {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

export interface ElectronAPI {
  files: {
    select: () => Promise<FileHandle[]>
    register: (paths: string[]) => Promise<FileHandle[]>
    read: (id: string) => Promise<string>
    readHead: (id: string, bytes: number) => Promise<string>
    countLines: (id: string) => Promise<number>
    streamChunks: (id: string, chunkLines: number, onChunk: (chunk: ChunkData) => void) => Promise<void>
    getPathForFile: (file: File) => string
  }
  odoo: {
    call: <T>(payload: OdooPayload) => Promise<OdooCallResult<T>>
    authenticate: (params: AuthParams) => Promise<AuthResult>
    listDatabases: (baseUrl: string) => Promise<DatabaseListResult>
  }
  store: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  profile: {
    selectZip: () => Promise<{ path: string; name: string } | null>
    upload: (payload: { baseUrl: string; filePath: string }) => Promise<ProfileUploadResult>
    export: (payload: { baseUrl: string; profileId: number; profileName: string }) => Promise<boolean>
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
}

contextBridge.exposeInMainWorld('api', {
  files: {
    select: () => ipcRenderer.invoke('files:select'),
    register: (paths: string[]) => ipcRenderer.invoke('files:register', paths),
    read: (id: string) => ipcRenderer.invoke('files:read', id),
    readHead: (id: string, bytes: number) => ipcRenderer.invoke('files:readHead', id, bytes),
    countLines: (id: string) => ipcRenderer.invoke('files:countLines', id),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    streamChunks: async (id: string, chunkLines: number, onChunk: (chunk: ChunkData) => void) => {
      const streamId = await ipcRenderer.invoke('files:streamChunks', id, chunkLines)

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
    }
  },
  odoo: {
    call: (payload: OdooPayload) => ipcRenderer.invoke('odoo:call', payload),
    authenticate: (params: AuthParams) => ipcRenderer.invoke('odoo:authenticate', params),
    listDatabases: (baseUrl: string) => ipcRenderer.invoke('odoo:listDatabases', baseUrl)
  },
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value)
  },
  profile: {
    selectZip: () => ipcRenderer.invoke('profile:selectZip'),
    upload: (payload: { baseUrl: string; filePath: string }) =>
      ipcRenderer.invoke('profile:upload', payload),
    export: (payload: { baseUrl: string; profileId: number; profileName: string }) =>
      ipcRenderer.invoke('profile:export', payload)
  }
} satisfies ElectronAPI)

declare global {
  interface Window {
    api: ElectronAPI
  }
}
