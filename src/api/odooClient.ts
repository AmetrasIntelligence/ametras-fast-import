import { useSessionStore } from '@/stores/session'

export interface OdooModel {
  id: number
  model: string
  name: string
  transient: boolean
}

export interface OdooField {
  name: string
  type: string
  string: string
  required: boolean
  readonly: boolean
  relation?: string
}

export async function fetchModels(): Promise<OdooModel[]> {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')
  const db = session.currentServer?.db

  const response = await window.api.odoo.call<Array<{ id: number; model: string; name: string }>>({
    baseUrl: session.baseUrl,
    db,
    endpoint: '/web/dataset/call_kw',
    params: {
      model: 'ir.model',
      method: 'search_read',
      args: [[['transient', '=', false]]],
      kwargs: {
        fields: ['id', 'model', 'name'],
        order: 'model'
      }
    }
  })

  if (!response.ok) throw new Error(response.error || 'Failed to fetch models')
  if (!response.result) throw new Error('Empty response from server')

  return response.result.map(r => ({
    id: r.id,
    model: r.model,
    name: r.name,
    transient: false
  }))
}

export interface SaveImportLogData {
  profile_name: string
  profile_id?: number
  is_dry_run: boolean
  state: 'completed' | 'failed'
  started_at: string   // ISO datetime
  finished_at: string  // ISO datetime
  filenames: string[]
  total_rows: number
  success_rows: number
  failed_rows: number
  error_log: Array<{ filename: string; rowNumber: number; error: string }>
}

export async function saveImportLog(data: SaveImportLogData): Promise<void> {
  const session = useSessionStore()
  if (!session.baseUrl || !session.isEmbedded) return  // Only save in embedded mode

  await window.api.odoo.call({
    baseUrl: session.baseUrl,
    db: session.currentServer?.db,
    endpoint: '/ametras_fast_import/log/save',
    params: { ...data },
  })
}

// --- Log Lifecycle API ---

export interface CreateImportLogData {
  profile_name: string
  profile_id?: number
  is_dry_run: boolean
  started_at: string
  filenames: string[]
  total_rows: number
  attachment_ids?: number[]
  file_progress?: Record<string, unknown>
}

export interface UpdateImportLogData {
  log_id: number
  success_rows: number
  failed_rows: number
  file_progress: Record<string, unknown>
}

export interface FinalizeImportLogData {
  log_id: number
  state: 'completed' | 'failed'
  finished_at: string
  total_rows?: number
  success_rows: number
  failed_rows: number
  error_log: Array<{ filename: string; rowNumber: number; error: string }>
  file_progress?: Record<string, unknown>
}

export interface ImportLogRecord {
  id: number
  profile_name: string
  profile_id: number | null
  user_id: number
  is_dry_run: boolean
  state: string
  started_at: string | null
  finished_at: string | null
  duration_seconds: number
  filenames: string[]
  total_rows: number
  success_rows: number
  failed_rows: number
  pending_rows: number
  file_progress: Record<string, FileProgressData>
  error_log: Array<{ filename: string; rowNumber: number; error: string }>
  attachment_ids: number[]
}

export interface FileProgressData {
  totalRows: number
  successCount: number
  failedCount: number
  processedRanges: [number, number][]
}

export async function createImportLog(data: CreateImportLogData): Promise<number | null> {
  const session = useSessionStore()
  if (!session.baseUrl || !session.isEmbedded) return null

  const response = await window.api.odoo.call<{ ok: boolean; id: number }>({
    baseUrl: session.baseUrl,
    db: session.currentServer?.db,
    endpoint: '/ametras_fast_import/log/create',
    params: { ...data },
  })

  if (response.ok && response.result?.ok) {
    return response.result.id
  }
  return null
}

export async function updateImportLog(data: UpdateImportLogData): Promise<void> {
  const session = useSessionStore()
  if (!session.baseUrl || !session.isEmbedded) return

  await window.api.odoo.call({
    baseUrl: session.baseUrl,
    db: session.currentServer?.db,
    endpoint: '/ametras_fast_import/log/update',
    params: { ...data },
  })
}

export async function finalizeImportLog(data: FinalizeImportLogData): Promise<void> {
  const session = useSessionStore()
  if (!session.baseUrl || !session.isEmbedded) return

  await window.api.odoo.call({
    baseUrl: session.baseUrl,
    db: session.currentServer?.db,
    endpoint: '/ametras_fast_import/log/finalize',
    params: { ...data },
  })
}

export async function getImportLog(logId: number): Promise<ImportLogRecord | null> {
  const session = useSessionStore()
  if (!session.baseUrl || !session.isEmbedded) return null

  const response = await window.api.odoo.call<{ ok: boolean; log: ImportLogRecord }>({
    baseUrl: session.baseUrl,
    db: session.currentServer?.db,
    endpoint: '/ametras_fast_import/log/get',
    params: { log_id: logId },
  })

  if (response.ok && response.result?.ok) {
    return response.result.log
  }
  return null
}

export async function fetchModelFields(modelName: string): Promise<OdooField[]> {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')
  const db = session.currentServer?.db

  const response = await window.api.odoo.call<Record<string, {
    string: string
    type: string
    required?: boolean
    readonly?: boolean
    relation?: string
  }>>({
    baseUrl: session.baseUrl,
    db,
    endpoint: '/web/dataset/call_kw',
    params: {
      model: modelName,
      method: 'fields_get',
      args: [],
      kwargs: {
        attributes: ['string', 'type', 'required', 'readonly', 'relation']
      }
    }
  })

  if (!response.ok) throw new Error(response.error || 'Failed to fetch fields')
  if (!response.result) throw new Error('Empty response from server')

  return Object.entries(response.result).map(([name, field]) => ({
    name,
    type: field.type,
    string: field.string,
    required: field.required || false,
    readonly: field.readonly || false,
    relation: field.relation
  }))
}

