import type { OdooField } from '@/api/odooClient'
import type { FieldTransform } from '@/types/fieldMapping'

export interface FieldMetadata {
  transform: FieldTransform
  required: boolean
}

export function getBaseFieldName(odooField: string): string {
  if (odooField.endsWith('/.id')) {
    return odooField.slice(0, -4)
  }
  if (odooField.endsWith('/id')) {
    return odooField.slice(0, -3)
  }
  return odooField
}

export function buildFieldLookup(fields: OdooField[]): Map<string, OdooField> {
  const lookup = new Map<string, OdooField>()
  for (const field of fields) {
    lookup.set(field.name, field)
  }
  return lookup
}

/**
 * Derive transform + required flags from selected Odoo field.
 */
export function computeFieldMetadata(
  csvHeader: string,
  odooField: string,
  fieldLookup: Map<string, OdooField>
): FieldMetadata {
  const baseName = getBaseFieldName(odooField)
  const field = fieldLookup.get(baseName)
  const isRelational = field?.type === 'many2one' || field?.type === 'many2many'

  let transform: FieldTransform = { type: 'passthrough' }
  let required = field?.required ?? false

  if (odooField.endsWith('/id') && isRelational && field?.relation) {
    transform = field.type === 'many2many'
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
