import { test, expect } from '@playwright/test'
import { mockLogin } from './helpers'

// The run view auto-starts the import on mount and, when there are no files,
// immediately redirects back to /import — so it can't be tested in isolation.
// Instead we drive the real import→run→results flow with a mocked engine.

test.describe('Run → Results (mocked engine)', () => {
  test('a completed import routes to the results view', async ({ page }) => {
    await mockLogin(page, {
      selectFiles: [{ id: 'f1', name: 'contacts.csv', size: 60 }],
      fileContents: { f1: 'name,ref\nAcme,001\n' },
      emulateUpload: true,
      importResult: { type: 'done', success: 1, failed: 0, errors: [] },
    })

    // Add a file and wait for it to be analyzed/ready.
    await page.getByText(/browse/i).first().click()
    await expect(page.getByText('contacts.csv')).toBeVisible()
    await expect(page.getByText(/1\s+rows/i)).toBeVisible({ timeout: 10000 })

    // Entering the run view auto-starts the import; on completion it routes to results.
    await page.goto('/#/run')
    await expect(page).toHaveURL(/#\/results/, { timeout: 20000 })
    await expect(page.getByRole('heading', { name: /import complete/i })).toBeVisible()
  })

  test('with no files the run view redirects back to import', async ({ page }) => {
    await mockLogin(page)
    await page.goto('/#/run')
    await expect(page).toHaveURL(/#\/import/, { timeout: 15000 })
  })
})
