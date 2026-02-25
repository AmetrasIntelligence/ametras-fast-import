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

