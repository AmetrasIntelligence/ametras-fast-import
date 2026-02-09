// Test fixtures based on demo CSV files

export const DEMO_CSV_PARTNER_TITLE = `id,name
res_title_id#1,
res_title_id#2,PARTS UND TOOLS
res_title_id#3,FRIMA
res_title_id#4,Firma
res_title_id#5,FRAU
res_title_id#6,FIRMA`

export const DEMO_CSV_BANK = `id,name,bic
res_bank#1,GEN0DEF1HZH,GEN0DEF1HZH
res_bank#2,DUETESM672,DUETESM672
res_bank#3,BYLADE1SRS,BYLADE1SRS
res_bank#4,VB Schwäbisch Gmünd,GENODES1VGD
res_bank#5,Fidor Bank München,FDDODEMMXXX`

export const DEMO_CSV_PARTNER_SIMPLE = `id,name,email,phone,is_company
partner_1,Test Company,test@example.com,+49123456,true
partner_2,John Doe,john@example.com,+49789012,false
partner_3,Jane Smith,jane@example.com,+49345678,false`

export const DEMO_CSV_LARGE_HEADER = `id,name,street,zip,city,country_id/.id,email,website,phone,fax,is_company,active,lang,customer_rank,supplier_rank`

// CSV with external ID references (for reference resolution testing)
export const DEMO_CSV_WITH_REFS = `id,name,categ_id/id,manufacturer_id/id,uom_id/.id
product_1,Widget A,product_category#123,res_partner_id#456,1
product_2,Widget B,product_category#123,res_partner_id#789,1
product_3,Gadget C,product_category#456,,1`

// CSV with Many2Many references (pipe-delimited)
export const DEMO_CSV_WITH_M2M_REFS = `id,name,route_ids/id,tag_ids/id
product_1,Product A,purchase_stock.route_warehouse0_buy|stock.route_warehouse0_mto,tag_red|tag_blue
product_2,Product B,purchase_stock.route_warehouse0_buy,tag_green`

// CSV with standard /.id references (countries, currencies, uom)
export const DEMO_CSV_WITH_DB_IDS = `id,name,country_id/.id,currency_id/.id,uom_id/.id
partner_1,Partner A,57,1,1
partner_2,Partner B,1,1,1
partner_3,Partner C,57,2,1`

export const DEMO_CSV_WITH_ERRORS = `id,name,email
partner_valid,Valid Partner,valid@example.com
partner_invalid,,invalid-email
partner_empty,Empty Email,`

export const DEMO_CSV_SPECIAL_CHARS = `id,name,description
special_1,"Company, Inc.","Line1
Line2"
special_2,"Quote ""Test""",Normal desc
special_3,Unicode äöü,Umlauts work`

// Generate large CSV for streaming tests
export function generateLargeCSV(rows: number): string {
  const lines = ['id,name,email,value']
  for (let i = 1; i <= rows; i++) {
    lines.push(`row_${i},Name ${i},email${i}@test.com,${i * 100}`)
  }
  return lines.join('\n')
}

// Mock file handles
export const mockFileHandles = {
  small: { id: 'file-small', name: 'partners.csv', size: 1024 },
  medium: { id: 'file-medium', name: 'products.csv', size: 1024 * 100 },
  large: { id: 'file-large', name: 'transactions.csv', size: 1024 * 1024 * 50 }
}

// Mock Odoo responses
export const mockOdooResponses = {
  authSuccess: {
    ok: true,
    uid: 2,
    session_id: 'abc123xyz',
    server_version: '16.0+e'
  },
  authFailed: {
    ok: false,
    error: 'Invalid credentials'
  },
  importSuccess: {
    results: [
      { ok: true, id: 1, external_id: 'partner_1', action: 'created' },
      { ok: true, id: 2, external_id: 'partner_2', action: 'created' }
    ]
  },
  importPartialFail: {
    results: [
      { ok: true, id: 1, external_id: 'partner_1', action: 'created' },
      { ok: false, error: 'Validation error: email is required' },
      { ok: true, id: 3, external_id: 'partner_3', action: 'created' }
    ]
  },
  importAllFail: {
    results: [
      { ok: false, error: 'Access denied' },
      { ok: false, error: 'Access denied' }
    ]
  },
  models: [
    { id: 1, model: 'res.partner', name: 'Contact' },
    { id: 2, model: 'product.template', name: 'Product' },
    { id: 3, model: 'res.bank', name: 'Bank' }
  ],
  fieldsPartner: {
    id: { type: 'integer', string: 'ID', required: false, readonly: true },
    name: { type: 'char', string: 'Name', required: true, readonly: false },
    email: { type: 'char', string: 'Email', required: false, readonly: false },
    phone: { type: 'char', string: 'Phone', required: false, readonly: false },
    is_company: { type: 'boolean', string: 'Is Company', required: false, readonly: false },
    parent_id: { type: 'many2one', string: 'Parent', required: false, readonly: false, relation: 'res.partner' },
    country_id: { type: 'many2one', string: 'Country', required: false, readonly: false, relation: 'res.country' },
    currency_id: { type: 'many2one', string: 'Currency', required: false, readonly: false, relation: 'res.currency' }
  },
  fieldsProduct: {
    id: { type: 'integer', string: 'ID', required: false, readonly: true },
    name: { type: 'char', string: 'Name', required: true, readonly: false },
    categ_id: { type: 'many2one', string: 'Category', required: true, readonly: false, relation: 'product.category' },
    manufacturer_id: { type: 'many2one', string: 'Manufacturer', required: false, readonly: false, relation: 'res.partner' },
    uom_id: { type: 'many2one', string: 'Unit of Measure', required: true, readonly: false, relation: 'uom.uom' },
    route_ids: { type: 'many2many', string: 'Routes', required: false, readonly: false, relation: 'stock.route' }
  },
  // Import with reference resolution
  importWithRefsSuccess: {
    results: [
      { ok: true, id: 1, external_id: 'product_1', action: 'created', strategy: 'create' },
      { ok: true, id: 2, external_id: 'product_2', action: 'created', strategy: 'create' }
    ],
    warnings: []
  },
  importWithRefsFail: {
    results: [
      { ok: false, error: "External ID 'product_category#999' not found for model product.category" }
    ]
  },
  importWithDbIdWarning: {
    results: [
      { ok: true, id: 1, external_id: 'partner_1', action: 'created', strategy: 'create' }
    ],
    warnings: [
      "Field 'country_id' uses database ID 57. Consider migrating to external ID for portability."
    ]
  }
}

// Server profiles for multi-server testing
export const mockServerProfiles = [
  { id: 'server-1', name: 'admin', baseUrl: 'https://company1.odoo.com', db: 'production' },
  { id: 'server-2', name: 'user', baseUrl: 'https://company2.odoo.com', db: 'staging' },
  { id: 'server-3', name: 'demo', baseUrl: 'http://localhost:8069', db: 'demo' }
]

// Run settings variations
export const mockRunSettings = {
  default: {
    batchSize: 200,
    workers: 1,
    retryLimit: 3,
    retryDelayMs: 2000,
    stopOnFatalError: false,
    encoding: 'utf-8-sig' as const,
    delimiter: ',' as const,
    skipHeader: true,
    dryRun: false,
    lang: 'de_DE'
  },
  small: {
    batchSize: 10,
    workers: 1,
    retryLimit: 1,
    retryDelayMs: 500,
    stopOnFatalError: true,
    encoding: 'utf-8' as const,
    delimiter: ';' as const,
    skipHeader: true,
    dryRun: false,
    lang: 'en_US'
  },
  large: {
    batchSize: 500,
    workers: 4,
    retryLimit: 5,
    retryDelayMs: 5000,
    stopOnFatalError: false,
    encoding: 'utf-8-sig' as const,
    delimiter: ',' as const,
    skipHeader: true,
    dryRun: false,
    lang: 'de_DE'
  },
  noRetry: {
    batchSize: 100,
    workers: 1,
    retryLimit: 0,
    retryDelayMs: 0,
    stopOnFatalError: true,
    encoding: 'latin-1' as const,
    delimiter: '\t' as const,
    skipHeader: false,
    dryRun: false,
    lang: 'de_DE'
  },
  dryRun: {
    batchSize: 200,
    workers: 1,
    retryLimit: 3,
    retryDelayMs: 2000,
    stopOnFatalError: false,
    encoding: 'utf-8-sig' as const,
    delimiter: ',' as const,
    skipHeader: true,
    dryRun: true,
    lang: 'de_DE'
  },
  parallel: {
    batchSize: 200,
    workers: 3,
    retryLimit: 3,
    retryDelayMs: 2000,
    stopOnFatalError: false,
    encoding: 'utf-8-sig' as const,
    delimiter: ',' as const,
    skipHeader: true,
    dryRun: false,
    lang: 'de_DE'
  }
}
