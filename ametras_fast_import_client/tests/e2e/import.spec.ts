import { test, expect } from '@playwright/test'
import { mockLogin } from './helpers'

test.describe('Import View - No Files', () => {
  test.beforeEach(async ({ page }) => {
    await mockLogin(page)
  })

  test('displays import heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /^import$/i })).toBeVisible()
  })

  test('shows drop zone with browse in empty state', async ({ page }) => {
    await expect(page.getByText(/drag & drop csv files/i)).toBeVisible()
    await expect(page.getByText(/browse/i)).toBeVisible()
  })
})

test.describe('Import View - File states', () => {
  test('a selected file uploads, analyzes, and becomes ready with a row count', async ({ page }) => {
    await mockLogin(page, {
      selectFiles: [{ id: 'f1', name: 'products.csv', size: 120 }],
      fileContents: { f1: 'name,ref\nAcme,001\nGlobex,002\n' },
      emulateUpload: true,
    })

    await page.getByText(/browse/i).first().click()

    // File appears in the list…
    await expect(page.getByText('products.csv')).toBeVisible()
    // …and reaches the ready state: its analyzed row count (2) is rendered.
    await expect(page.getByText(/2\s+rows/i)).toBeVisible({ timeout: 10000 })
    // No error state for a good file.
    await expect(page.locator('.csv-file-list__state--error')).toHaveCount(0)
    // Config UI is now shown (hasFiles).
    await expect(page.getByRole('button', { name: /start import/i })).toBeVisible()
  })

  test('surfaces an error for a file that cannot be analyzed', async ({ page }) => {
    await mockLogin(page, {
      // No fileContents → every analysis path yields no columns → error state.
      selectFiles: [{ id: 'bad', name: 'broken.csv', size: 10 }],
      fileContents: {},
      emulateUpload: true,
    })

    await page.getByText(/browse/i).first().click()

    await expect(page.getByText('broken.csv')).toBeVisible()
    const errorChip = page.locator('.csv-file-list__state--error')
    await expect(errorChip).toBeVisible({ timeout: 10000 })
    await expect(errorChip).toContainText(/failed/i)
  })
})
