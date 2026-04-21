/// <reference types="vite/client" />

declare global {
  const __APP_VERSION__: string
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
  /** Optional request timeout in ms. Falls back to default (30s) if omitted. */
  timeout?: number
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

interface ProfileUploadResult {
  ok: boolean
  result?: {
    id: number
    name: string
    version: string
    description: string
    mappings: Array<{ filename: string; model: string; searchKeys?: string[]; strict?: boolean }>
    sequence: Array<{ order: number; filename: string; requires?: string[] }>
    run_settings: Record<string, string>
    field_mappings: Array<{ filename: string; csvHeader?: string; csvColumn?: string; odooField: string; required?: boolean; transform?: string; notes?: string }>
    [key: string]: unknown
  }
  error?: string
}

interface StandaloneDetectResult {
  available: boolean
  version?: string
  odooVersion?: string
  error?: string
}

interface StandaloneLoadParams {
  baseUrl: string
  db: string
  model: string
  header: string[]
  rows: (string | number | boolean | null)[][]
  /** Optional timeout override for this request (milliseconds). */
  timeoutMs?: number
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

interface PythonImportResult {
  type: 'done' | 'error'
  success?: number
  failed?: number
  errors?: Array<{ row: number; error: string; file?: string }>
  message?: string
}

interface ElectronAPI {
  files: {
    select: () => Promise<FileHandle[]>
    register: (paths: string[]) => Promise<FileHandle[]>
    read: (id: string, encoding?: string) => Promise<string>
    readHead: (id: string, bytes: number, encoding?: string) => Promise<string>
    countLines: (id: string) => Promise<number>
    streamChunks: (id: string, chunkLines: number, onChunk: (chunk: ChunkData) => void) => Promise<void>
    // Async streaming with backpressure support
    streamStart: (id: string, chunkLines: number, encoding?: string, hasHeader?: boolean) => Promise<string>
    streamNext: (streamId: string) => Promise<ChunkData>
    streamClose: (streamId: string) => Promise<void>
    cleanupStreams: () => Promise<void>
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

  python: {
    detect: () => Promise<{ available: boolean; pythonPath?: string }>
    start: (payload?: { pythonPath?: string }) => Promise<{ ok: boolean; error?: string }>
    stop: () => Promise<{ ok: boolean }>
    cancel: () => Promise<{ ok: boolean }>
    authenticate: (params: { url: string; db: string; login: string; password: string }) => Promise<Record<string, unknown>>
    import: (payload: Record<string, unknown>) => Promise<PythonImportResult>
    analyze: (payload: { fileId: string; encoding?: string; delimiter?: string }) => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>
    models: (payload: { url: string; db: string; uid: number; password: string }) => Promise<Record<string, unknown>>
    fields: (payload: { url: string; db: string; uid: number; password: string; model: string }) => Promise<Record<string, unknown>>
    progress: () => Promise<Record<string, unknown>[]>
  }
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}

export {}
