import { test, expect, type Page } from '@playwright/test'

/**
 * Layer 2: end-to-end against a LIVE embedded Odoo (real web client + real
 * controllers + real DB). It drives the real UI through starting an import
 * (real upload → analyze → model → /import/start → csv.import.log + live run
 * view). Import completion and log correctness are covered deterministically by
 * the Odoo HttpCase (test_import_http_flow.py) — a browser test can't run the
 * queue-job worker. Point at the server with ODOO_URL.
 */

const LOGIN = process.env.ODOO_LOGIN || 'admin'
const PASSWORD = process.env.ODOO_PASSWORD || 'admin'

async function login(page: Page) {
  // Render the embedded Vue app in English (it defaults to German and otherwise
  // syncs from the Odoo user's locale). The CI DB also sets admin to en_US.
  await page.addInitScript(() => localStorage.setItem('csv-import-locale', 'en'))
  await page.goto('/web/login')
  await page.locator('input[name="login"]').fill(LOGIN)
  await page.locator('input[name="password"]').fill(PASSWORD)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL(/\/web/, { timeout: 30_000 })
}

async function openImportApp(page: Page) {
  // The client action loads the Vue bundle then mounts it into the web client.
  await page.goto('/web#action=ametras_fast_import_addon.action_csv_import_vue_app')
  await expect(page.getByText(/drag & drop csv files/i)).toBeVisible({ timeout: 45_000 })
}

test.describe('Embedded app (live Odoo)', () => {
  test('mounts the CSV import app inside the Odoo web client', async ({ page }) => {
    await login(page)
    await openImportApp(page)
    await expect(page.getByText(/browse/i)).toBeVisible()
  })

  test('workflow: upload → analyze → model → start import (live run view)', async ({ page }) => {
    await login(page)
    await openImportApp(page)

    // Upload via the native file chooser the app triggers on "browse".
    page.once('filechooser', (fc) =>
      fc.setFiles({
        name: 'contacts.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('name,email\nAlice,alice@example.com\nBob,bob@example.com\n'),
      }),
    )
    await page.getByText(/browse/i).first().click()

    // Real upload + analysis → file becomes ready with its row count.
    await expect(page.getByText('contacts.csv')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/2\s+rows/i)).toBeVisible({ timeout: 30_000 })

    // Expand and pick a real Odoo model.
    await page.getByText('contacts.csv').click()
    await page.locator('.csv-model-select__trigger').first().click()
    await page.getByPlaceholder(/search by name/i).fill('res.partner')
    // "res.partner" is a substring of several models (res.partner.bank, …), so
    // match the option whose technical-name node is exactly res.partner.
    await page
      .locator('.csv-dropdown__option')
      .filter({ has: page.getByText('res.partner', { exact: true }) })
      .first()
      .click()

    // Start — drives the real backend: /import/start creates the csv.import.log
    // and opens the live run view polling real progress for the uploaded file.
    const startBtn = page.getByRole('button', { name: /start import/i })
    await expect(startBtn).toBeEnabled()
    await startBtn.click()

    // The run view opens and tracks the file we just uploaded (real log created).
    await expect(page.getByRole('progressbar')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('heading', { name: /^files$/i })).toBeVisible()
    await expect(page.getByText('contacts.csv')).toBeVisible()
  })
})
