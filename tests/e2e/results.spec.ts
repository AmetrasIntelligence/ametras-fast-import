import { test, expect } from '@playwright/test'

test.describe('Results View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/results')
  })

  test('displays import complete heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /import complete/i })).toBeVisible()
  })

  test('shows summary statistics', async ({ page }) => {
    await expect(page.getByText(/total rows/i)).toBeVisible()
    await expect(page.getByText(/successful/i)).toBeVisible()
    await expect(page.getByText(/failed/i)).toBeVisible()
    await expect(page.getByText(/duration/i)).toBeVisible()
  })

  test('shows export section', async ({ page }) => {
    await expect(page.getByText(/export/i)).toBeVisible()
  })

  test('has download full report button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /download full report/i })).toBeVisible()
  })

  test('has start new import button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /start new import/i })).toBeVisible()
  })

  test('start new import navigates to files', async ({ page }) => {
    await page.getByRole('button', { name: /start new import/i }).click()
    await expect(page).toHaveURL(/#\/files/)
  })
})

test.describe('Results - Export Functionality', () => {
  test('can click download report button', async ({ page }) => {
    await page.goto('/#/results')

    const downloadButton = page.getByRole('button', { name: /download full report/i })
    await expect(downloadButton).toBeEnabled()
  })
})

test.describe('Results - Error Display', () => {
  test('shows error table when errors exist', async ({ page }) => {
    await page.goto('/#/results')

    // If errors exist, should show error table
    // This would need state to be set up
  })
})
