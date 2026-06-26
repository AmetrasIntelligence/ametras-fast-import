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

export interface OdooLanguage {
  code: string
  name: string
}

/**
 * Fetch the languages installed/active on the server, for the language picker.
 * Uses res.lang.get_installed() (a model method, not a domain search) so it
 * works over RPC and avoids servers with quirky search overrides.
 */
export async function fetchLanguages(): Promise<OdooLanguage[]> {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')
  const db = session.currentServer?.db

  const installed = await window.api.odoo.call<Array<[string, string]>>({
    baseUrl: session.baseUrl,
    db,
    endpoint: '/web/dataset/call_kw',
    params: { model: 'res.lang', method: 'get_installed', args: [], kwargs: {} }
  })
  return installed.ok && installed.result
    ? installed.result.map(([code, name]) => ({ code, name }))
    : []
}

interface FileProgressData {
  totalRows: number
  successCount: number
  failedCount: number
  processedRanges: [number, number][]
}

interface ImportLogRecord {
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

// ── Row validation ──────────────────────────────────────────────────

export interface RowValidationResult {
  ok: boolean
  message?: string
  action?: string
}

/**
 * Validate a single sample row against an Odoo model via dry-run.
 *
 * When the addon's dry_run endpoint is available (useAddonEndpoint=true),
 * uses /ametras_fast_import/run. Otherwise falls back to Odoo's built-in
 * base_import.import with execute_import(dryrun=True), which is always
 * available on any Odoo 16 instance.
 */
export async function validateSampleRow(
  model: string,
  sampleRow: Record<string, string>,
  fieldMappings: Record<string, string>,
  useAddonEndpoint: boolean,
): Promise<RowValidationResult> {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')
  const db = session.currentServer?.db

  if (useAddonEndpoint) {
    return validateViaAddon(session.baseUrl, db, model, sampleRow, fieldMappings)
  }
  return validateViaBaseImport(session.baseUrl, db, model, sampleRow, fieldMappings)
}

async function validateViaAddon(
  baseUrl: string,
  db: string | undefined,
  model: string,
  sampleRow: Record<string, string>,
  fieldMappings: Record<string, string>,
): Promise<RowValidationResult> {
  const hasIdMapping = Object.values(fieldMappings).includes('id')

  const result = await window.api.odoo.call<{
    results: Array<{ ok: boolean; action?: string; error?: string }>
  }>({
    baseUrl,
    db,
    endpoint: '/ametras_fast_import/run',
    params: {
      model,
      raw_rows: [sampleRow],
      field_mappings: fieldMappings,
      use_external_id: hasIdMapping,
      dry_run: true,
    },
  })

  if (result.ok && result.result?.results?.length) {
    const r = result.result.results[0]
    return { ok: r.ok, message: r.error, action: r.action }
  }
  if (result.ok) return { ok: true }
  return { ok: false, message: result.error || 'Validation request failed' }
}

/**
 * Build a minimal CSV string from mapped headers + one data row.
 */
function buildValidationCsv(
  sampleRow: Record<string, string>,
  mappedHeaders: string[],
): string {
  const escape = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
      return `"${val.replace(/"/g, '""')}"`
    }
    return val
  }
  return [
    mappedHeaders.map(escape).join(','),
    mappedHeaders.map(h => escape(sampleRow[h] ?? '')).join(','),
  ].join('\n') + '\n'
}

async function validateViaBaseImport(
  baseUrl: string,
  db: string | undefined,
  model: string,
  sampleRow: Record<string, string>,
  fieldMappings: Record<string, string>,
): Promise<RowValidationResult> {
  const mappedHeaders = Object.keys(fieldMappings).filter(h => fieldMappings[h])
  const fields = mappedHeaders.map(h => fieldMappings[h])

  const csv = buildValidationCsv(sampleRow, mappedHeaders)

  // Base64-encode for Odoo binary field (TextEncoder handles UTF-8)
  const bytes = new TextEncoder().encode(csv)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = btoa(binary)

  // Create a transient base_import.import record
  const createResp = await window.api.odoo.call<number>({
    baseUrl, db,
    endpoint: '/web/dataset/call_kw',
    params: {
      model: 'base_import.import',
      method: 'create',
      args: [{ res_model: model, file: base64, file_type: 'text/csv', file_name: 'validation.csv' }],
      kwargs: {},
    },
  })
  if (!createResp.ok || !createResp.result) {
    return { ok: false, message: createResp.error || 'Failed to create import record' }
  }

  // Call execute_import with dryrun — savepoint + rollback, nothing committed
  const execResp = await window.api.odoo.call<{
    ids: number[] | false
    messages: Array<{ type: string; message: string; record?: number; field?: string }>
  }>({
    baseUrl, db,
    endpoint: '/web/dataset/call_kw',
    params: {
      model: 'base_import.import',
      method: 'execute_import',
      args: [[createResp.result], fields, mappedHeaders, {
        separator: ',',
        quoting: '"',
        has_headers: true,
      }],
      kwargs: { dryrun: true },
    },
  })
  if (!execResp.ok) {
    return { ok: false, message: execResp.error || 'Validation request failed' }
  }

  const result = execResp.result!
  const errors = result.messages.filter(m => m.type === 'error')
  if (errors.length > 0) {
    return { ok: false, message: errors.map(e => e.message).join('; ') }
  }

  const action = result.ids && Array.isArray(result.ids) && result.ids.length > 0 ? 'create' : 'processed'
  return { ok: true, action }
}

// ── Field metadata ──────────────────────────────────────────────────

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
