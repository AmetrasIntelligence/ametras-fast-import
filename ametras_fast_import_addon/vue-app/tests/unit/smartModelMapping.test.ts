import { describe, it, expect } from 'vitest'
import { suggestModel } from '@/utils/smartModelMapping'
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
  { id: 11, model: 'res.partner.bank', name: 'Bank Accounts', transient: false },
  { id: 12, model: 'res.partner.category', name: 'Contact Tags', transient: false },
  { id: 13, model: 'purchase.order', name: 'Purchase Order', transient: false },
]

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
    expect(result!.model.model).toBe('res.partner')
  })

  it('includes score in result', () => {
    const result = suggestModel('partners.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.score).toBeGreaterThan(0)
  })

  // Fix 1: Full technical name match
  it('matches sale_order.csv to sale.order via full tech name', () => {
    const result = suggestModel('sale_order.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('sale.order')
    expect(result!.score).toBeGreaterThanOrEqual(90)
  })

  // Fix 2: Length mismatch penalty — res.partner beats res.partner.bank for partner.csv
  it('prefers res.partner over res.partner.bank for partner.csv', () => {
    const result = suggestModel('partner.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('res.partner')
  })

  // Fix 3: Common prefix noise — res_partner.csv should match res.partner
  it('matches res_partner.csv to res.partner', () => {
    const result = suggestModel('res_partner.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('res.partner')
  })

  // Fix 4: Depluralization — employees.csv matches hr.employee
  it('matches employees.csv to hr.employee via depluralization', () => {
    const result = suggestModel('employees.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('hr.employee')
  })

  // Fix 5: German mappings
  it('matches Kunden.csv to res.partner (German)', () => {
    const result = suggestModel('Kunden.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('res.partner')
  })

  it('matches Artikel.csv to product.template (German)', () => {
    const result = suggestModel('Artikel.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('product.template')
  })

  it('matches Rechnungen.csv to account.move (German)', () => {
    const result = suggestModel('Rechnungen.csv', mockModels)
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('account.move')
  })

  // Fix 6: Header-based scoring
  it('boosts res.partner score when headers contain email/phone/street', () => {
    const headers = ['name', 'email', 'phone', 'street']
    const withHeaders = suggestModel('data.csv', mockModels, 1, { headers })
    const withoutHeaders = suggestModel('data.csv', mockModels, 1)

    // With partner-related headers, res.partner should be suggested
    if (withHeaders) {
      expect(withHeaders.model.model).toBe('res.partner')
    }
    // Score should be higher with headers than without
    const withScore = withHeaders?.score ?? 0
    const withoutScore = withoutHeaders?.score ?? 0
    expect(withScore).toBeGreaterThan(withoutScore)
  })

  it('boosts product.template score when headers contain barcode/weight', () => {
    const headers = ['name', 'barcode', 'weight', 'list_price']
    const result = suggestModel('data.csv', mockModels, 1, { headers })
    expect(result).not.toBeNull()
    expect(result!.model.model).toBe('product.template')
  })
})

