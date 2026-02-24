import { Page, expect } from '@playwright/test'

/**
 * Set the app locale to English via localStorage.
 * Must be called BEFORE navigating to any page.
 */
export async function setEnglishLocale(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('csv-import-locale', 'en')
  })
}

/**
 * Install a mock window.api BEFORE main.ts runs.
 * Since main.ts checks `if (!window.api)` and only creates the browser
 * fallback when it's missing, setting window.api early ensures all API
 * calls hit our mock instead of making real network requests.
 * Must be called BEFORE navigating to any page.
 */
export async function mockWindowApi(page: Page) {
  await page.addInitScript(() => {
    const browserStore: Record<string, unknown> = {}
    ;(window as any).api = {
      files: {
        select: async () => [],
        register: async () => [],
        read: async () => '',
        readHead: async () => '',
        countLines: async () => 0,
        streamChunks: async () => {},
        streamStart: async () => '',
        streamNext: async () => ({ data: '', done: true }),
        streamClose: async () => {},
        getPathForFile: () => ''
      },
      odoo: {
        call: async () => ({ ok: true, result: [] }),
        authenticate: async () => ({
          ok: true,
          uid: 1,
          session_id: 'test-session',
          server_version: '16.0'
        }),
        listDatabases: async () => ({ ok: true, databases: ['testdb'] })
      },
      store: {
        get: async (key: string) => browserStore[key] ?? null,
        set: async (key: string, value: unknown) => { browserStore[key] = value }
      },
      profile: {
        selectZip: async () => null,
        upload: async () => ({ ok: false, error: 'Not available' }),
        export: async () => false
      },
      standalone: {
        detectAddon: async () => ({
          available: true,
          version: '1.0.0',
          odooVersion: '16.0'
        }),
        load: async () => ({ ok: true, ids: [], messages: [] }),
        getOdooVersion: async () => ({ version: null })
      }
    }
  })
}

/**
 * Perform a mock login via the login page.
 * Sets up window.api mock, fills the form, and waits for redirect to /import.
 */
export async function mockLogin(page: Page) {
  await setEnglishLocale(page)
  await mockWindowApi(page)

  // Navigate to login page
  await page.goto('/')
  await expect(page.locator('#csv-import-app')).toBeVisible({ timeout: 15000 })

  // Fill login form
  await page.getByPlaceholder(/mycompany\.odoo\.com/i).fill('localhost')
  await page.getByPlaceholder(/database name/i).fill('testdb')
  await page.getByPlaceholder(/admin/i).fill('admin')
  await page.getByLabel(/password/i).fill('admin')

  // Submit
  await page.getByRole('button', { name: /connect/i }).click()

  // Wait for redirect to import page
  await page.waitForURL(/#\/import/, { timeout: 15000 })
}
