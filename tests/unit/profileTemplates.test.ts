import { describe, it, expect } from 'vitest'
import { getTemplate, getAllTemplates } from '@/utils/profileTemplates'

describe('getAllTemplates', () => {
  it('returns 4 templates', () => {
    const templates = getAllTemplates()
    expect(templates).toHaveLength(4)
  })

  it('each template has id, name, description', () => {
    const templates = getAllTemplates()
    for (const t of templates) {
      expect(t.id).toBeTruthy()
      expect(t.name).toBeTruthy()
      expect(t.description).toBeTruthy()
    }
  })

  it('contains product template', () => {
    const templates = getAllTemplates()
    expect(templates.find(t => t.id === 'product-import')).toBeDefined()
  })

  it('contains CRM template', () => {
    const templates = getAllTemplates()
    expect(templates.find(t => t.id === 'crm-import')).toBeDefined()
  })

  it('contains sales template', () => {
    const templates = getAllTemplates()
    expect(templates.find(t => t.id === 'sales-import')).toBeDefined()
  })

  it('contains accounting template', () => {
    const templates = getAllTemplates()
    expect(templates.find(t => t.id === 'accounting-import')).toBeDefined()
  })
})

describe('getTemplate', () => {
  it('returns a full ImportProfile for product template', () => {
    const profile = getTemplate('product-import')

    expect(profile.name).toBe('Product Import')
    expect(profile.version).toBe('1.0')
    expect(profile.description).toBeTruthy()
    expect(profile.mappings.length).toBeGreaterThan(0)
    expect(profile.sequence.length).toBeGreaterThan(0)
    expect(profile.runSettings).toBeDefined()
    expect(profile.runSettings.batchSize).toBe(200)
    expect(profile.fieldMappings).toBeDefined()
    expect(profile.fieldMappings!.length).toBeGreaterThan(0)
    expect(profile.id).toBe(0) // Template profiles use 0; server assigns real ID on upload
    expect(profile.createdAt).toBeGreaterThan(0)
  })

  it('returns a full ImportProfile for CRM template', () => {
    const profile = getTemplate('crm-import')

    expect(profile.name).toBe('CRM Import')
    expect(profile.mappings).toHaveLength(3)
    expect(profile.sequence).toHaveLength(3)
    expect(profile.sequence[0].order).toBe(1)
  })

  it('returns a full ImportProfile for sales template', () => {
    const profile = getTemplate('sales-import')

    expect(profile.name).toBe('Sales Import')
    expect(profile.mappings).toHaveLength(3)
  })

  it('returns a full ImportProfile for accounting template', () => {
    const profile = getTemplate('accounting-import')

    expect(profile.name).toBe('Accounting Import')
    expect(profile.mappings).toHaveLength(3)
  })

  it('throws for unknown template', () => {
    expect(() => getTemplate('unknown')).toThrow('Template not found: unknown')
  })

  it('returns consistent id for templates', () => {
    const p1 = getTemplate('product-import')
    const p2 = getTemplate('product-import')
    expect(p1.id).toBe(0)
    expect(p2.id).toBe(0)
  })

  it('includes default run settings', () => {
    const profile = getTemplate('product-import')
    expect(profile.runSettings.encoding).toBe('utf-8-sig')
    expect(profile.runSettings.delimiter).toBe(',')
    expect(profile.runSettings.skipHeader).toBe(true)
    expect(profile.runSettings.dryRun).toBe(false)
    expect(profile.runSettings.lang).toBe('de_DE')
  })
})
