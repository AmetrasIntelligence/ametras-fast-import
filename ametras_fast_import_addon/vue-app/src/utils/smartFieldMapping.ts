import type { OdooField } from '@/api/odooClient'

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

