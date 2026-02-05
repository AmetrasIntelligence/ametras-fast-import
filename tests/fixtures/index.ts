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
    parent_id: { type: 'many2one', string: 'Parent', required: false, readonly: false, relation: 'res.partner' }
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
    retryLimit: 3,
    retryDelayMs: 2000,
    stopOnFatalError: false,
    encoding: 'utf-8-sig' as const,
    delimiter: ',' as const,
    skipHeader: true,
    dryRun: true,
    lang: 'de_DE'
  }
}
