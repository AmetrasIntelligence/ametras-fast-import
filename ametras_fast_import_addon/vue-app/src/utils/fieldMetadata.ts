import type { OdooField } from '@/api/odooClient'
import type { FieldTransform } from '@/types/fieldMapping'

/**
 * Strip an `/id` or `/.id` suffix from a mapping target to get the base field name.
 */
export function baseFieldName(odooField: string): string {
  if (odooField.endsWith('/.id')) return odooField.slice(0, -4)
  if (odooField.endsWith('/id')) return odooField.slice(0, -3)
  return odooField
}

/**
 * Derive the auto transform and required flag for a CSV column → Odoo field mapping.
 *
 * `field` is the base Odoo field (already resolved from `baseFieldName(odooField)`).
 * This is the single source of truth shared by `useFieldMetadata` (import flow)
 * and the standalone profile editor.
 */
export function deriveFieldMetadata(
  field: OdooField | undefined,
  odooField: string,
  csvHeader: string
): { transform: FieldTransform; required: boolean } {
  const isRelational = field?.type === 'many2one' || field?.type === 'many2many'

  let transform: FieldTransform = { type: 'passthrough' }
  let required = field?.required ?? false

  if (odooField.endsWith('/id') && isRelational && field?.relation) {
    transform =
      field.type === 'many2many'
        ? { type: 'm2m_ref', model: field.relation }
        : { type: 'm2o_ref', model: field.relation }
  } else if (odooField.endsWith('/.id') && isRelational && field?.relation) {
    transform = { type: 'db_id', model: field.relation }
  }

  if (csvHeader === 'id' || odooField === 'id') {
    required = true
  }

  return { transform, required }
}
