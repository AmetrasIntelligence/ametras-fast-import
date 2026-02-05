import { describe, it, expect } from 'vitest'
import { suggestModel, getSuggestions, levenshteinDistance, scoreMatch } from '@/utils/smartMapping'
import type { OdooModel } from '@/api/odooClient'

const mockModels: OdooModel[] = [
  { id: 1, model: 'res.partner', name: 'Contact', transient: false },
  { id: 2, model: 'product.template', name: 'Product', transient: false },
  { id: 3, model: 'product.product', name: 'Product Variant', transient: false },
  { id: 4, model: 'res.bank', name: 'Bank', transient: false },
  { id: 5, model: 'sale.order', name: 'Sales Order', transient: false },
  { id: 6, model: 'crm.lead', name: 'Lead/Opportunity', transient: false },
  { id: 7, model: 'hr.employee', name: 'Employee', transient: false },
  { id: 8, model: 'account.move', name: 'Journal Entry', transient: false },
  { id: 9, model: 'res.users', name: 'User', transient: false },
  { id: 10, model: 'product.category', name: 'Product Category', transient: false },
]

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('abc', 'abc')).toBe(0)
  })

  it('returns correct distance for single edit', () => {
    expect(levenshteinDistance('abc', 'ab')).toBe(1)
    expect(levenshteinDistance('abc', 'axc')).toBe(1)
  })

  it('returns correct distance for multiple edits', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3)
  })

  it('handles empty strings', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3)
    expect(levenshteinDistance('abc', '')).toBe(3)
    expect(levenshteinDistance('', '')).toBe(0)
  })
})

describe('scoreMatch', () => {
  it('gives highest score for exact display name match', () => {
    const model: OdooModel = { id: 1, model: 'res.partner', name: 'Contact', transient: false }
    expect(scoreMatch('Contact.csv', model)).toBe(100)
  })

  it('gives high score for technical name part match', () => {
    const model: OdooModel = { id: 1, model: 'res.partner', name: 'Contact', transient: false }
    expect(scoreMatch('partner.csv', model)).toBeGreaterThanOrEqual(80)
  })

  it('gives bonus for common patterns', () => {
    const model: OdooModel = { id: 1, model: 'res.partner', name: 'Contact', transient: false }
    const score = scoreMatch('customers.csv', model)
    expect(score).toBeGreaterThanOrEqual(50)
  })

  it('gives zero for completely unrelated names', () => {
    const model: OdooModel = { id: 1, model: 'res.partner', name: 'Contact', transient: false }
    expect(scoreMatch('invoices.csv', model)).toBe(0)
  })
})

describe('suggestModel', () => {
  it('suggests res.partner for partners.csv', () => {
    const result = suggestModel('partners.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('res.partner')
  })

  it('suggests res.partner for customers.csv', () => {
    const result = suggestModel('customers.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('res.partner')
  })

  it('suggests product.template for products.csv', () => {
    const result = suggestModel('products.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('product.template')
  })

  it('suggests res.bank for banks.csv', () => {
    const result = suggestModel('banks.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('res.bank')
  })

  it('suggests sale.order for sales.csv', () => {
    const result = suggestModel('sales.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('sale.order')
  })

  it('suggests crm.lead for leads.csv', () => {
    const result = suggestModel('leads.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('crm.lead')
  })

  it('returns null when no match above minScore', () => {
    const result = suggestModel('zzz_random_file.csv', mockModels, 50)
    expect(result).toBeNull()
  })

  it('handles underscores and hyphens in filename', () => {
    const result = suggestModel('my_partners_list.csv', mockModels)
    expect(result).not.toBeNull()
    // Should match something partner-related
    expect(result!.model.model).toBe('res.partner')
  })

  it('includes score in result', () => {
    const result = suggestModel('partners.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.score).toBeGreaterThan(0)
  })
})

describe('getSuggestions', () => {
  it('returns ranked suggestions', () => {
    const suggestions = getSuggestions('partner.csv', mockModels)
    expect(suggestions.length).toBeGreaterThan(0)
    // Should be sorted by score descending
    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i - 1].score).toBeGreaterThanOrEqual(suggestions[i].score)
    }
  })

  it('respects limit parameter', () => {
    const suggestions = getSuggestions('partner.csv', mockModels, 2)
    expect(suggestions.length).toBeLessThanOrEqual(2)
  })

  it('returns empty array for no matches', () => {
    const suggestions = getSuggestions('zzzzzzz.csv', mockModels)
    expect(suggestions).toEqual([])
  })

  it('first suggestion is the best match', () => {
    const suggestions = getSuggestions('partners.csv', mockModels)
    expect(suggestions[0].model.model).toBe('res.partner')
  })
})
