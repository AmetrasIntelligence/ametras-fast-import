export interface FieldMapping {
  filename: string
  csvHeader: string
  odooField: string
  required: boolean
  transform: FieldTransform
  notes?: string
}

/**
 * Field transforms define how CSV values are converted for Odoo import.
 *
 * - passthrough: Value passed as-is
 * - m2o_ref: Many2One reference via external ID (e.g., "partner_id/id" -> "res_partner#123")
 * - m2m_ref: Many2Many reference via pipe-delimited external IDs (e.g., "tag_ids/id" -> "tag_a|tag_b")
 * - db_id: Database ID for standard Odoo reference data only (countries, currencies, UoM, languages)
 */
export type FieldTransform =
  | { type: 'passthrough' }
  | { type: 'm2o_ref'; model: string }
  | { type: 'm2m_ref'; model: string }
  | { type: 'db_id'; model: string }

/**
 * Models allowed for db_id (/.id) references.
 * These are standard Odoo reference data with stable IDs across instances.
 */
export const STANDARD_DB_ID_MODELS = new Set([
  'res.country',
  'res.currency',
  'uom.uom',
  'res.lang',
  'res.country.state',
  'res.partner.title'
])

export function parseTransform(value: string): FieldTransform {
  if (!value || value.trim() === '') {
    return { type: 'passthrough' }
  }

  if (value.startsWith('m2o_ref:')) {
    const model = value.slice('m2o_ref:'.length)
    return { type: 'm2o_ref', model }
  }

  if (value.startsWith('m2m_ref:')) {
    const model = value.slice('m2m_ref:'.length)
    return { type: 'm2m_ref', model }
  }

  if (value.startsWith('db_id:')) {
    const model = value.slice('db_id:'.length)
    return { type: 'db_id', model }
  }

  throw new Error(`Unknown transform: ${value}`)
}

export function serializeTransform(transform: FieldTransform): string {
  switch (transform.type) {
    case 'passthrough':
      return ''
    case 'm2o_ref':
      return `m2o_ref:${transform.model}`
    case 'm2m_ref':
      return `m2m_ref:${transform.model}`
    case 'db_id':
      return `db_id:${transform.model}`
  }
}
