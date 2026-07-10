import { test, expect, type Page } from '@playwright/test'

/**
 * Layer 2: end-to-end against a LIVE embedded Odoo (real web client + real
 * controllers + real DB). The CI job boots Odoo with QUEUE_JOB__NO_DELAY=1 so
 * /import/start completes inline. Point at it with ODOO_URL.
 */

const LOGIN = process.env.ODOO_LOGIN || 'admin'
const PASSWORD = process.env.ODOO_PASSWORD || 'admin'

async function login(page: Page) {
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

  test('full workflow: upload → analyze → model → run → results', async ({ page }) => {
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
    await page.getByPlaceholder(/search by name/i).fill('partner')
    await page.locator('.csv-dropdown__option', { hasText: 'res.partner' }).click()

    // Start — the import runs inline (QUEUE_JOB__NO_DELAY) and routes to results.
    const startBtn = page.getByRole('button', { name: /start import/i })
    await expect(startBtn).toBeEnabled()
    await startBtn.click()

    await expect(page.getByRole('heading', { name: /import complete/i })).toBeVisible({
      timeout: 60_000,
    })
  })
})
