import { Page, expect } from '@playwright/test'

/**
 * Serializable options that shape the mocked window.api. Passed into an
 * addInitScript, so it must contain only plain data (no functions).
 */
export interface MockApiOptions {
  /** odoo.authenticate result. Default: succeeds. */
  authOk?: boolean
  /** python.detect availability. Default: true. */
  pythonAvailable?: boolean
  /** Handles returned by files.select(). */
  selectFiles?: { id: string; name: string; size: number }[]
  /** CSV text per file id — drives the JS (PapaParse) analysis fallback. */
  fileContents?: Record<string, string>
  /**
   * When true, files.select() emulates the Odoo-embedded upload flow by
   * invoking the progress callbacks (onStaged → onUploaded) so the UI shows
   * uploading → analyzing → ready.
   */
  emulateUpload?: boolean
  /** Result object returned by python.import(). Default: a clean "done". */
  importResult?: Record<string, unknown>
  /** Models returned by ir.model search_read (drives ModelSelect). */
  models?: { id: number; model: string; name: string }[]
  /** fields_get result per model (drives field auto-mapping). */
  modelFields?: Record<
    string,
    Record<string, { string: string; type: string; required?: boolean; store?: boolean; relation?: string }>
  >
}

/**
 * Set the app locale to English via localStorage. Call BEFORE navigating.
 */
export async function setEnglishLocale(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('csv-import-locale', 'en')
  })
}

/**
 * Install a complete mock window.api BEFORE main.ts runs. Mirrors the real
 * ElectronAPI surface the app touches at startup and during a run, so the app
 * doesn't crash on missing methods (the previous mock omitted python.* and
 * odoo.getEncryptionInfo, which LoginView calls on mount). Call BEFORE navigating.
 */
export async function mockWindowApi(page: Page, options: MockApiOptions = {}) {
  await page.addInitScript((opts: MockApiOptions) => {
    const authOk = opts.authOk ?? true
    const pythonAvailable = opts.pythonAvailable ?? true
    const selectFiles = opts.selectFiles ?? []
    const fileContents = opts.fileContents ?? {}
    const importResult = opts.importResult ?? {
      type: 'done', success: 0, failed: 0, errors: [],
    }
    const models = opts.models ?? [
      { id: 1, model: 'res.partner', name: 'Contact' },
      { id: 2, model: 'product.template', name: 'Product' },
    ]
    const modelFields = opts.modelFields ?? {
      'res.partner': {
        name: { string: 'Name', type: 'char', required: true, store: true },
        email: { string: 'Email', type: 'char', store: true },
        phone: { string: 'Phone', type: 'char', store: true },
      },
    }
    const browserStore: Record<string, unknown> = {}

    function contentFor(id: string): string {
      return fileContents[id] ?? ''
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      files: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        select: async (progress?: any) => {
          if (opts.emulateUpload && progress) {
            progress.onStaged?.(selectFiles.map(f => ({ name: f.name, size: f.size })))
            for (const f of selectFiles) progress.onUploaded?.(f)
          }
          return selectFiles
        },
        register: async () => selectFiles,
        read: async (id: string) => contentFor(id),
        readHead: async (id: string) => contentFor(id),
        countLines: async (id: string) => {
          const c = contentFor(id)
          if (!c) return 0
          return c.split('\n').filter(l => l.length > 0).length
        },
        streamChunks: async () => {},
        streamStart: async () => '',
        streamNext: async () => ({ data: '', done: true }),
        streamClose: async () => {},
        cleanupStreams: async () => {},
        getPathForFile: () => '',
      },
      odoo: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        call: async (payload?: any) => {
          const endpoint: string = payload?.endpoint ?? ''
          const params = payload?.params ?? {}
          if (endpoint.includes('/web/dataset/call_kw')) {
            if (params.model === 'ir.model' && params.method === 'search_read') {
              return { ok: true, result: models }
            }
            if (params.method === 'fields_get') {
              return { ok: true, result: modelFields[params.model] ?? {} }
            }
          }
          if (endpoint.includes('/file/analyze')) {
            // Last-resort analyze fallback: return a well-formed (empty) analysis
            // so a file with no parseable content lands in the error state.
            return {
              ok: true,
              result: { headers: [], rowCount: 0, sampleRows: [], delimiter: ',', hasIdColumn: false, hasDotIdColumn: false },
            }
          }
          return { ok: true, result: [] }
        },
        authenticate: async () =>
          authOk
            ? { ok: true, uid: 1, session_id: 'test-session', server_version: '16.0' }
            : { ok: false, error: 'Invalid credentials' },
        listDatabases: async () => ({ ok: true, databases: ['testdb'] }),
        getEncryptionInfo: async () => ({ available: false, platform: 'test' }),
        pinSession: async () => ({ ok: true }),
        ping: async () => ({ ok: true }),
      },
      store: {
        get: async (key: string) => browserStore[key] ?? null,
        set: async (key: string, value: unknown) => { browserStore[key] = value },
      },
      profile: {
        selectZip: async () => null,
        upload: async () => ({ ok: false, error: 'Not available' }),
        export: async () => false,
      },
      standalone: {
        detectAddon: async () => ({ available: true, version: '1.0.0', odooVersion: '16.0' }),
        load: async () => ({ ok: true, ids: [], messages: [] }),
        getOdooVersion: async () => ({ version: null }),
      },
      python: {
        detect: async () => ({ available: pythonAvailable }),
        start: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        cancel: async () => ({ ok: true }),
        authenticate: async () => ({ type: 'authenticated', uid: 1 }),
        import: async () => importResult,
        // Force the deterministic JS/PapaParse analysis path (via readHead).
        analyze: async () => ({ ok: false, error: 'use-js-fallback' }),
        models: async () => ({ type: 'models', models: [] }),
        fields: async () => ({ type: 'fields', fields: [] }),
        progress: async () => [],
      },
    }
  }, options)
}

/**
 * Mock-login via the login page: installs the API mock, fills the form, and
 * waits for the redirect to /import.
 */
export async function mockLogin(page: Page, options: MockApiOptions = {}) {
  await setEnglishLocale(page)
  await mockWindowApi(page, options)

  await page.goto('/')
  await expect(page.locator('#csv-import-app')).toBeVisible({ timeout: 15000 })

  await page.getByPlaceholder(/mycompany\.odoo\.com/i).fill('localhost')
  await page.getByPlaceholder(/database name/i).fill('testdb')
  await page.getByPlaceholder(/admin/i).fill('admin')
  await page.getByLabel(/password/i).fill('admin')

  await page.getByRole('button', { name: /connect/i }).click()
  await page.waitForURL(/#\/import/, { timeout: 15000 })
}
