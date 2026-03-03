import type { OdooModel } from '@/api/odooClient'

// ── String similarity utilities (merged from stringSimilarity.ts) ────

/**
 * Calculate the Levenshtein distance between two strings.
 * Returns the minimum number of single-character edits needed.
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

/**
 * Normalize a string for comparison by lowercasing and removing separators.
 */
export function normalizeForComparison(str: string): string {
  return str.toLowerCase().replace(/[-_\s.]/g, '')
}

/**
 * Tokenize a string into words by splitting on common separators.
 */
export function tokenize(str: string): string[] {
  return str
    .toLowerCase()
    .replace(/[-_.]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0)
}

/**
 * Simple English depluralization: strip common plural suffixes.
 */
export function depluralize(word: string): string {
  if (word.length <= 3) return word
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y'   // categories → category
  if (word.endsWith('ses')) return word.slice(0, -2)          // addresses → address
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)  // partners → partner
  return word
}

// ── Smart mapping ────────────────────────────────────────────────────

export interface SuggestModelOptions {
  headers?: string[]
}

/** Odoo module namespace prefixes that are noise for filename matching */
const COMMON_PREFIXES = new Set(['res', 'ir', 'base', 'mail', 'bus'])

/** English + German filename → model common mappings */
const commonMappings: Record<string, string[]> = {
  // English
  'customers': ['res.partner'],
  'partners': ['res.partner'],
  'contacts': ['res.partner'],
  'products': ['product.template', 'product.product'],
  'items': ['product.template'],
  'orders': ['sale.order', 'purchase.order'],
  'sales': ['sale.order'],
  'purchases': ['purchase.order'],
  'invoices': ['account.move'],
  'users': ['res.users'],
  'employees': ['hr.employee'],
  'banks': ['res.bank'],
  'categories': ['product.category'],
  'leads': ['crm.lead'],
  // German
  'kunden': ['res.partner'],
  'kontakte': ['res.partner'],
  'lieferanten': ['res.partner'],
  'artikel': ['product.template', 'product.product'],
  'produkte': ['product.template', 'product.product'],
  'auftraege': ['sale.order'],
  'bestellungen': ['purchase.order'],
  'rechnungen': ['account.move'],
  'mitarbeiter': ['hr.employee'],
  'banken': ['res.bank'],
  'kategorien': ['product.category'],
}

/** Header patterns that hint at a specific model */
const headerModelHints: Record<string, string[]> = {
  'res.partner': ['email', 'phone', 'street', 'city', 'zip', 'country', 'vat', 'website'],
  'product.template': ['list_price', 'standard_price', 'barcode', 'weight', 'ean', 'sku', 'uom'],
  'sale.order': ['order_line', 'amount_total', 'partner_id', 'date_order', 'pricelist'],
  'account.move': ['invoice_line', 'amount_total', 'journal', 'payment_term'],
  'hr.employee': ['department', 'job_title', 'work_email', 'coach', 'manager'],
}

/**
 * Score how well a filename matches an Odoo model.
 * Higher score = better match. Uses layered scoring (A–F).
 */
function scoreMatch(filename: string, model: OdooModel, headers?: string[]): number {
  const name = filename
    .replace(/\.csv$/i, '')
    .replace(/[-_]/g, ' ')
    .toLowerCase()
    .trim()

  const modelName = model.name.toLowerCase()

  let score = 0

  // --- Layer A: Exact display name match → 100 ---
  if (name === modelName) return 100

  // --- Layer B: Normalized full technical name match → 90 ---
  const normalizedFilename = name.replace(/\s+/g, '')
  const normalizedTechName = model.model.toLowerCase().replace(/\./g, '')
  if (normalizedFilename === normalizedTechName) {
    score = Math.max(score, 90)
  }

  // --- Layer C: Technical part exact match with length penalty → 80 minus penalty ---
  const techParts = model.model.toLowerCase().split('.')
  if (techParts.some(p => p === name)) {
    const partScore = 80 - 10 * (techParts.length - 1)
    score = Math.max(score, partScore)
  }

  // --- Layer D: Common mappings (EN + DE) → 50 primary / 40 secondary ---
  for (const [pattern, models] of Object.entries(commonMappings)) {
    if (name.includes(pattern)) {
      const idx = models.indexOf(model.model)
      if (idx === 0) {
        score = Math.max(score, 50)
      } else if (idx > 0) {
        score = Math.max(score, 40)
      }
    }
  }

  // --- Layer E: Word-level matching with depluralization, ignoring common prefixes ---
  const nameWords = name.split(/\s+/).filter(w => w.length >= 3)
  const technicalName = model.model.toLowerCase().replace(/\./g, ' ')
  const modelWords = [...new Set([...modelName.split(/\s+/), ...technicalName.split(/\s+/)])]
    .filter(w => !COMMON_PREFIXES.has(w))

  for (const nw of nameWords) {
    const nwDeplural = depluralize(nw)
    if (COMMON_PREFIXES.has(nwDeplural)) continue

    for (const mw of modelWords) {
      const mwDeplural = depluralize(mw)
      if (nwDeplural === mwDeplural) {
        score += 30
      } else if (mwDeplural.includes(nwDeplural) || nwDeplural.includes(mwDeplural)) {
        score += 15
      } else if (levenshteinDistance(nwDeplural, mwDeplural) <= 2) {
        score += 10
      }
    }
  }

  // --- Layer F: Header-based bonus (additive, max +25) ---
  if (headers && headers.length > 0) {
    const hints = headerModelHints[model.model]
    if (hints) {
      let headerBonus = 0
      const normalizedHeaders = headers.map(h => h.toLowerCase().replace(/[-_\s]/g, ''))
      for (const hint of hints) {
        const normalizedHint = hint.replace(/[-_\s]/g, '')
        if (normalizedHeaders.some(h => h.includes(normalizedHint) || normalizedHint.includes(h))) {
          headerBonus += 8
        }
      }
      score += Math.min(headerBonus, 25)
    }
  }

  return score
}

/**
 * Find best matching Odoo model for a filename.
 */
export function suggestModel(
  filename: string,
  models: OdooModel[],
  minScore = 20,
  options?: SuggestModelOptions
): { model: OdooModel; score: number } | null {
  let bestMatch: OdooModel | null = null
  let bestScore = 0

  for (const model of models) {
    const score = scoreMatch(filename, model, options?.headers)
    if (score > bestScore && score >= minScore) {
      bestScore = score
      bestMatch = model
    }
  }

  return bestMatch ? { model: bestMatch, score: bestScore } : null
}

/**
 * Get ranked suggestions for a filename.
 */
export function getSuggestions(
  filename: string,
  models: OdooModel[],
  limit = 5,
  options?: SuggestModelOptions
): Array<{ model: OdooModel; score: number }> {
  return models
    .map(model => ({ model, score: scoreMatch(filename, model, options?.headers) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
