import type { OdooModel } from '@/api/odooClient'
import { levenshteinDistance } from '@/utils/stringSimilarity'

/**
 * Score how well a filename matches an Odoo model.
 * Higher score = better match.
 */
function scoreMatch(filename: string, model: OdooModel): number {
  const name = filename
    .replace(/\.csv$/i, '')
    .replace(/[-_]/g, ' ')
    .toLowerCase()
    .trim()

  const modelName = model.name.toLowerCase()
  const technicalName = model.model.toLowerCase().replace(/\./g, ' ')

  let score = 0

  // Exact match on display name
  if (name === modelName) return 100

  // Exact match on technical name parts
  const techParts = model.model.split('.')
  if (techParts.some(p => p.toLowerCase() === name)) {
    score += 80
  }

  // Partial matches (deduplicate model words to avoid double-counting)
  const nameWords = name.split(/\s+/)
  const modelWords = [...new Set([...modelName.split(/\s+/), ...technicalName.split(/\s+/)])]

  for (const nw of nameWords) {
    if (nw.length < 3) continue

    for (const mw of modelWords) {
      if (mw === nw) {
        score += 30
      } else if (mw.includes(nw) || nw.includes(mw)) {
        score += 15
      } else if (levenshteinDistance(nw, mw) <= 2) {
        score += 10
      }
    }
  }

  // Bonus for common patterns
  const commonMappings: Record<string, string[]> = {
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
  }

  for (const [pattern, models] of Object.entries(commonMappings)) {
    if (name.includes(pattern)) {
      const idx = models.indexOf(model.model)
      if (idx === 0) {
        score += 50  // Primary match
      } else if (idx > 0) {
        score += 40  // Secondary match
      }
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
  minScore = 20
): { model: OdooModel; score: number } | null {
  let bestMatch: OdooModel | null = null
  let bestScore = 0

  for (const model of models) {
    const score = scoreMatch(filename, model)
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
  limit = 5
): Array<{ model: OdooModel; score: number }> {
  return models
    .map(model => ({ model, score: scoreMatch(filename, model) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// levenshteinDistance and scoreMatch are internal helpers, not exported
