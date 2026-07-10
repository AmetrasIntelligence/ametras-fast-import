import { test, expect } from '@playwright/test'
import { mockLogin } from './helpers'

/**
 * End-to-end coverage of the full import workflow, driving the REAL Vue
 * components (file list, ModelSelect, field auto-mapping, run, results) with a
 * mocked IPC layer — as close to a live run as possible without a real Odoo.
 */

test.describe('Full import workflow', () => {
  test('select → analyze → pick model → auto-map fields → run → results', async ({ page }) => {
    await mockLogin(page, {
      selectFiles: [{ id: 'f1', name: 'contacts.csv', size: 80 }],
      fileContents: { f1: 'name,email\nAcme,a@acme.co\nGlobex,g@globex.co\n' },
      emulateUpload: true,
      importResult: { type: 'done', success: 2, failed: 0, errors: [] },
    })

    // 1) Add the file and wait until analysis reports its 2 rows (ready).
    await page.getByText(/browse/i).first().click()
    await expect(page.getByText('contacts.csv')).toBeVisible()
    await expect(page.getByText(/2\s+rows/i)).toBeVisible({ timeout: 10000 })

    // 2) Expand the row → the analyzed CSV preview is shown.
    await page.getByText('contacts.csv').click()
    await expect(page.getByText(/csv preview/i)).toBeVisible()

    // 3) Pick a target model via the real ModelSelect dropdown.
    await page.locator('.csv-model-select__trigger').first().click()
    await page.getByPlaceholder(/search by name/i).fill('partner')
    await page.locator('.csv-dropdown__option', { hasText: 'res.partner' }).click()

    // 4) Fields auto-map (name→name, email→email) → the mapping table renders,
    //    and the chosen model is shown on the file row.
    await expect(page.locator('.csv-field-mapping__table')).toBeVisible()
    await expect(page.getByText('res.partner').first()).toBeVisible()

    // 5) Start Import is now enabled → run → routes to results.
    const startBtn = page.getByRole('button', { name: /start import/i })
    await expect(startBtn).toBeEnabled()
    await startBtn.click()

    await expect(page).toHaveURL(/#\/results/, { timeout: 20000 })
    await expect(page.getByRole('heading', { name: /import complete/i })).toBeVisible()

    // 6) The results summary reflects the 2 successfully-imported rows.
    await expect(page.locator('.fs-2.fw-bold.text-success')).toHaveText('2')
  })

  test('multiple files: both analyze, and one can be removed', async ({ page }) => {
    await mockLogin(page, {
      selectFiles: [
        { id: 'a', name: 'partners.csv', size: 40 },
        { id: 'b', name: 'products.csv', size: 40 },
      ],
      fileContents: {
        a: 'name,email\nA,a@x.co\n',
        b: 'name,ref\nWidget,W1\n',
      },
      emulateUpload: true,
    })

    await page.getByText(/browse/i).first().click()

    // Both files land in the list and become ready.
    await expect(page.getByText('partners.csv')).toBeVisible()
    await expect(page.getByText('products.csv')).toBeVisible()
    await expect(page.locator('.csv-file-list__item')).toHaveCount(2)
    await expect(page.locator('.csv-file-list__state--error')).toHaveCount(0)

    // Remove one file — it disappears, the other remains.
    await page
      .locator('.csv-file-list__item', { hasText: 'partners.csv' })
      .locator('.csv-file-list__remove')
      .click()

    await expect(page.getByText('partners.csv')).toHaveCount(0)
    await expect(page.getByText('products.csv')).toBeVisible()
    await expect(page.locator('.csv-file-list__item')).toHaveCount(1)
  })
})
