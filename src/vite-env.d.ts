/// <reference types="vite/client" />

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

interface ProfileUploadResult {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

interface ElectronAPI {
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

declare global {
  interface Window {
    api: ElectronAPI
  }
}

export {}
