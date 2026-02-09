import type { OdooField } from '@/api/odooClient'
import type { FieldTransform } from '@/types/fieldMapping'
import { STANDARD_DB_ID_MODELS } from '@/types/fieldMapping'

/**
 * Score how well a CSV header matches an Odoo field.
 * Used for suggestions only, never auto-applied.
 */
export function scoreFieldMatch(header: string, field: OdooField): number {
  const h = header.toLowerCase().replace(/[-_\s]/g, '')
  const fieldName = field.name.toLowerCase().replace(/_/g, '')
  const fieldLabel = field.string.toLowerCase().replace(/[-_\s]/g, '')

  // Exact matches
  if (h === fieldName) return 100
  if (h === fieldLabel) return 95

  // Field name without common suffixes
  const cleanFieldName = fieldName.replace(/id$|ids$/, '')
  if (h === cleanFieldName) return 90

  // Common aliases (German and English) — checked before contains
  const aliases: Record<string, string[]> = {
    'name': ['title', 'bezeichnung', 'nom'],
    'email': ['mail', 'email', 'email'],
    'phone': ['tel', 'telefon', 'telephone'],
    'street': ['address', 'adresse', 'strasse'],
    'city': ['stadt', 'ort', 'ville'],
    'zip': ['postcode', 'postal', 'plz'],
    'countryid': ['country', 'land', 'pays'],
    'partnerid': ['customer', 'client', 'kunde'],
    'productid': ['product', 'artikel', 'item'],
    'quantity': ['qty', 'menge', 'amount'],
    'price': ['preis', 'cost', 'prix'],
    'ref': ['reference', 'referenz', 'kundenr', 'kundennr'],
    'website': ['web', 'url', 'homepage'],
    'fax': ['telefax'],
    'mobile': ['mobil', 'handy', 'cell'],
    'comment': ['notiz', 'note', 'bemerkung'],
    'active': ['aktiv'],
    'lang': ['sprache', 'language'],
    'iscompany': ['firma', 'company', 'unternehmen'],
  }

  for (const [fieldKey, headerAliases] of Object.entries(aliases)) {
    if (fieldName === fieldKey && headerAliases.some(a => h.includes(a))) {
      return 70
    }
  }

  // Contains (require minimum length to avoid short header false positives)
  if (h.length >= 3) {
    if (fieldName.includes(h) || h.includes(fieldName)) return 60
    if (fieldLabel.includes(h) || h.includes(fieldLabel)) return 55
  }

  return 0
}

/**
 * Auto-map CSV headers to Odoo fields.
 * Returns mapping of csvHeader → odooFieldName.
 */
export function autoMapFields(
  headers: string[],
  fields: OdooField[],
  minScore = 50
): Record<string, string> {
  const mapping: Record<string, string> = {}
  const usedFields = new Set<string>()

  // Pre-pass 1: handle id and .id columns (upsert keys)
  // These are special columns that control create vs update behavior
  for (const header of headers) {
    if (header === 'id' || header === '.id') {
      mapping[header] = header  // Map directly: id → id, .id → .id
    }
  }

  // Pre-pass 2: handle /id and /.id suffixed headers (relational field references)
  for (const header of headers) {
    if (header.endsWith('/id') || header.endsWith('/.id')) {
      const suffix = header.endsWith('/.id') ? '/.id' : '/id'
      const baseName = header.slice(0, -suffix.length)
      const field = fields.find(f => f.name === baseName && (f.type === 'many2one' || f.type === 'many2many'))
      if (field && !usedFields.has(field.name)) {
        mapping[header] = header  // Map directly: partner_id/id → partner_id/id
        usedFields.add(field.name)
      }
    }
  }

  // First pass: find all matches
  const matches: Array<{ header: string; field: OdooField; score: number }> = []

  for (const header of headers) {
    if (mapping[header]) continue  // Already mapped in pre-pass (id, .id, or relational /id)
    if (header === 'id' || header === '.id') continue  // Already handled
    if (header.endsWith('/id') || header.endsWith('/.id')) continue  // Unmatched /id suffix, skip

    for (const field of fields) {
      if (field.readonly || usedFields.has(field.name)) continue

      const score = scoreFieldMatch(header, field)
      if (score >= minScore) {
        matches.push({ header, field, score })
      }
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score)

  // Assign best non-conflicting matches
  for (const { header, field } of matches) {
    if (mapping[header] || usedFields.has(field.name)) continue

    mapping[header] = field.name
    usedFields.add(field.name)
  }

  return mapping
}

/**
 * Get suggestions for a single header.
 */
export function getFieldSuggestions(
  header: string,
  fields: OdooField[],
  limit = 5
): Array<{ field: OdooField; score: number }> {
  return fields
    .filter(f => !f.readonly)
    .map(field => ({ field, score: scoreFieldMatch(header, field) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Detect the appropriate transform based on CSV header pattern and Odoo field type.
 *
 * Rules:
 * - Header ends with /id + field is many2one → m2o_ref:relation
 * - Header ends with /id + field is many2many → m2m_ref:relation
 * - Header ends with /.id + field is relational → db_id:relation (only if standard model)
 * - Otherwise → passthrough
 *
 * @deprecated Use detectTransformFromMapping for better accuracy when odooField differs from csvHeader
 */
export function detectTransform(csvHeader: string, field: OdooField): FieldTransform {
  const isRelational = field.type === 'many2one' || field.type === 'many2many'

  // External ID reference: /id suffix
  if (csvHeader.endsWith('/id') && isRelational && field.relation) {
    if (field.type === 'many2many') {
      return { type: 'm2m_ref', model: field.relation }
    }
    return { type: 'm2o_ref', model: field.relation }
  }

  // Database ID reference: /.id suffix (only for standard models)
  if (csvHeader.endsWith('/.id') && isRelational && field.relation) {
    if (STANDARD_DB_ID_MODELS.has(field.relation)) {
      return { type: 'db_id', model: field.relation }
    }
    // For non-standard models, still allow but it's a warning situation
    return { type: 'db_id', model: field.relation }
  }

  return { type: 'passthrough' }
}

/**
 * Detect transform based on the mapped Odoo field (which may have /id or /.id suffix).
 * This is the correct function to use when the CSV header doesn't match the odoo field pattern.
 *
 * @param odooField - The target Odoo field (e.g., "country_id/.id", "partner_id/id", "name")
 * @param field - The base Odoo field metadata (without suffix)
 */
export function detectTransformFromMapping(odooField: string, field: OdooField | undefined): FieldTransform {
  if (!field) {
    return { type: 'passthrough' }
  }

  const isRelational = field.type === 'many2one' || field.type === 'many2many'

  // External ID reference: /id suffix on odoo field
  if (odooField.endsWith('/id') && isRelational && field.relation) {
    if (field.type === 'many2many') {
      return { type: 'm2m_ref', model: field.relation }
    }
    return { type: 'm2o_ref', model: field.relation }
  }

  // Database ID reference: /.id suffix on odoo field
  if (odooField.endsWith('/.id') && isRelational && field.relation) {
    return { type: 'db_id', model: field.relation }
  }

  return { type: 'passthrough' }
}

/**
 * Get base field name by stripping /id or /.id suffix.
 */
export function getBaseFieldName(odooField: string): string {
  if (odooField.endsWith('/.id')) {
    return odooField.slice(0, -4)
  }
  if (odooField.endsWith('/id')) {
    return odooField.slice(0, -3)
  }
  return odooField
}

/**
 * Transform a CSV value based on the field transform type.
 * Returns the value ready for Odoo import.
 */
export function transformValue(
  value: string,
  odooField: string,
  transform: FieldTransform
): { field: string; value: unknown } {
  const baseField = getBaseFieldName(odooField)

  switch (transform.type) {
    case 'db_id':
      // Database ID: convert to integer
      return { field: baseField, value: parseInt(value, 10) }

    case 'm2o_ref':
      // External ID reference for many2one: pass as string for backend resolution
      return { field: baseField, value: value }

    case 'm2m_ref':
      // External ID reference for many2many: pass as string (pipe-delimited) for backend resolution
      return { field: baseField, value: value }

    case 'passthrough':
    default:
      // Handle special id column
      if (odooField === 'id') {
        return { field: '__external_id__', value: value }
      }
      if (odooField === '.id') {
        return { field: '__db_id__', value: parseInt(value, 10) }
      }
      return { field: odooField, value: value }
  }
}

/**
 * Rich mapping result with required and transform auto-detected.
 */
export interface RichFieldMapping {
  csvHeader: string
  odooField: string
  required: boolean
  transform: FieldTransform
}

/**
 * Auto-map CSV headers to Odoo fields with full mapping info.
 * Returns rich mappings including required flag and transform type.
 */
export function autoMapFieldsRich(
  headers: string[],
  fields: OdooField[],
  minScore = 50
): RichFieldMapping[] {
  const mappings: RichFieldMapping[] = []
  const usedFields = new Set<string>()

  // Build field lookup map
  const fieldMap = new Map<string, OdooField>()
  for (const field of fields) {
    fieldMap.set(field.name, field)
  }

  // Pre-pass 1: handle id and .id columns (upsert keys)
  for (const header of headers) {
    if (header === 'id' || header === '.id') {
      mappings.push({
        csvHeader: header,
        odooField: header,
        required: true, // id column is always required for upsert
        transform: { type: 'passthrough' }
      })
    }
  }

  // Pre-pass 2: handle /id and /.id suffixed headers (relational field references)
  for (const header of headers) {
    if (header.endsWith('/id') || header.endsWith('/.id')) {
      const suffix = header.endsWith('/.id') ? '/.id' : '/id'
      const baseName = header.slice(0, -suffix.length)
      const field = fieldMap.get(baseName)

      if (field && (field.type === 'many2one' || field.type === 'many2many') && !usedFields.has(field.name)) {
        mappings.push({
          csvHeader: header,
          odooField: header, // Keep full header as odooField for reference columns
          required: field.required,
          transform: detectTransform(header, field)
        })
        usedFields.add(field.name)
      }
    }
  }

  // Main pass: score-based matching for remaining headers
  const matches: Array<{ header: string; field: OdooField; score: number }> = []

  for (const header of headers) {
    if (mappings.some(m => m.csvHeader === header)) continue
    if (header === 'id' || header === '.id') continue
    if (header.endsWith('/id') || header.endsWith('/.id')) continue

    for (const field of fields) {
      if (field.readonly || usedFields.has(field.name)) continue

      const score = scoreFieldMatch(header, field)
      if (score >= minScore) {
        matches.push({ header, field, score })
      }
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score)

  // Assign best non-conflicting matches
  for (const { header, field } of matches) {
    if (mappings.some(m => m.csvHeader === header) || usedFields.has(field.name)) continue

    mappings.push({
      csvHeader: header,
      odooField: field.name,
      required: field.required,
      transform: { type: 'passthrough' }
    })
    usedFields.add(field.name)
  }

  return mappings
}
