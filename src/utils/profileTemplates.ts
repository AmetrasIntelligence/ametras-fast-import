import type { ImportProfile, ProfileMapping, ProfileSequenceItem, ProfileFieldMapping } from '@/types/importProfile'
import { DEFAULT_RUN_SETTINGS } from '@/constants/defaults'

export interface ProfileTemplate {
  id: string
  name: string
  description: string
  mappings: ProfileMapping[]
  sequence: ProfileSequenceItem[]
  fieldMappings: ProfileFieldMapping[]
}

const templates: ProfileTemplate[] = [
  {
    id: 'product-import',
    name: 'Product Import',
    description: 'Import product categories and products with variants.',
    mappings: [
      { filename: 'product_categories.csv', model: 'product.category' },
      { filename: 'products.csv', model: 'product.template' }
    ],
    sequence: [
      { order: 1, filename: 'product_categories.csv' },
      { order: 2, filename: 'products.csv' }
    ],
    fieldMappings: [
      { filename: 'product_categories.csv', csvColumn: 'id', odooField: 'id' },
      { filename: 'product_categories.csv', csvColumn: 'name', odooField: 'name' },
      { filename: 'product_categories.csv', csvColumn: 'parent_id', odooField: 'parent_id/id' },
      { filename: 'products.csv', csvColumn: 'id', odooField: 'id' },
      { filename: 'products.csv', csvColumn: 'name', odooField: 'name' },
      { filename: 'products.csv', csvColumn: 'categ_id', odooField: 'categ_id/id' },
      { filename: 'products.csv', csvColumn: 'list_price', odooField: 'list_price' },
      { filename: 'products.csv', csvColumn: 'default_code', odooField: 'default_code' }
    ]
  },
  {
    id: 'crm-import',
    name: 'CRM Import',
    description: 'Import partner titles, companies, contacts, and leads.',
    mappings: [
      { filename: 'partner_titles.csv', model: 'res.partner.title' },
      { filename: 'companies.csv', model: 'res.partner' },
      { filename: 'contacts.csv', model: 'res.partner' }
    ],
    sequence: [
      { order: 1, filename: 'partner_titles.csv' },
      { order: 2, filename: 'companies.csv' },
      { order: 3, filename: 'contacts.csv' }
    ],
    fieldMappings: [
      { filename: 'partner_titles.csv', csvColumn: 'id', odooField: 'id' },
      { filename: 'partner_titles.csv', csvColumn: 'name', odooField: 'name' },
      { filename: 'companies.csv', csvColumn: 'id', odooField: 'id' },
      { filename: 'companies.csv', csvColumn: 'name', odooField: 'name' },
      { filename: 'companies.csv', csvColumn: 'email', odooField: 'email' },
      { filename: 'companies.csv', csvColumn: 'phone', odooField: 'phone' },
      { filename: 'companies.csv', csvColumn: 'street', odooField: 'street' },
      { filename: 'companies.csv', csvColumn: 'city', odooField: 'city' },
      { filename: 'companies.csv', csvColumn: 'zip', odooField: 'zip' },
      { filename: 'contacts.csv', csvColumn: 'id', odooField: 'id' },
      { filename: 'contacts.csv', csvColumn: 'name', odooField: 'name' },
      { filename: 'contacts.csv', csvColumn: 'email', odooField: 'email' },
      { filename: 'contacts.csv', csvColumn: 'parent_id', odooField: 'parent_id/id' }
    ]
  },
  {
    id: 'sales-import',
    name: 'Sales Import',
    description: 'Import partners, products, and sale orders with lines.',
    mappings: [
      { filename: 'partners.csv', model: 'res.partner' },
      { filename: 'products.csv', model: 'product.template' },
      { filename: 'sale_orders.csv', model: 'sale.order' }
    ],
    sequence: [
      { order: 1, filename: 'partners.csv' },
      { order: 2, filename: 'products.csv' },
      { order: 3, filename: 'sale_orders.csv' }
    ],
    fieldMappings: [
      { filename: 'partners.csv', csvColumn: 'id', odooField: 'id' },
      { filename: 'partners.csv', csvColumn: 'name', odooField: 'name' },
      { filename: 'partners.csv', csvColumn: 'email', odooField: 'email' },
      { filename: 'products.csv', csvColumn: 'id', odooField: 'id' },
      { filename: 'products.csv', csvColumn: 'name', odooField: 'name' },
      { filename: 'products.csv', csvColumn: 'list_price', odooField: 'list_price' },
      { filename: 'sale_orders.csv', csvColumn: 'id', odooField: 'id' },
      { filename: 'sale_orders.csv', csvColumn: 'partner_id', odooField: 'partner_id/id' },
      { filename: 'sale_orders.csv', csvColumn: 'date_order', odooField: 'date_order' }
    ]
  },
  {
    id: 'accounting-import',
    name: 'Accounting Import',
    description: 'Import chart of accounts, journals, and accounting entries.',
    mappings: [
      { filename: 'accounts.csv', model: 'account.account' },
      { filename: 'journals.csv', model: 'account.journal' },
      { filename: 'moves.csv', model: 'account.move' }
    ],
    sequence: [
      { order: 1, filename: 'accounts.csv' },
      { order: 2, filename: 'journals.csv' },
      { order: 3, filename: 'moves.csv' }
    ],
    fieldMappings: [
      { filename: 'accounts.csv', csvColumn: 'id', odooField: 'id' },
      { filename: 'accounts.csv', csvColumn: 'code', odooField: 'code' },
      { filename: 'accounts.csv', csvColumn: 'name', odooField: 'name' },
      { filename: 'journals.csv', csvColumn: 'id', odooField: 'id' },
      { filename: 'journals.csv', csvColumn: 'name', odooField: 'name' },
      { filename: 'journals.csv', csvColumn: 'code', odooField: 'code' },
      { filename: 'journals.csv', csvColumn: 'type', odooField: 'type' },
      { filename: 'moves.csv', csvColumn: 'id', odooField: 'id' },
      { filename: 'moves.csv', csvColumn: 'journal_id', odooField: 'journal_id/id' },
      { filename: 'moves.csv', csvColumn: 'date', odooField: 'date' }
    ]
  }
]

/**
 * Get a template by ID and return it as a full ImportProfile.
 */
export function getTemplate(id: string): ImportProfile {
  const template = templates.find(t => t.id === id)
  if (!template) throw new Error(`Template not found: ${id}`)

  return {
    id: 0,  // Template profiles are not persisted; id is set upon server upload
    name: template.name,
    version: '1.0',
    description: template.description,
    mappings: template.mappings,
    sequence: template.sequence,
    runSettings: { ...DEFAULT_RUN_SETTINGS },
    fieldMappings: template.fieldMappings,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

/**
 * List all available templates (id, name, description).
 */
export function getAllTemplates(): Array<{ id: string; name: string; description: string }> {
  return templates.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description
  }))
}
