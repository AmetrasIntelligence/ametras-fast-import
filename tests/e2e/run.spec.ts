import { test, expect } from '@playwright/test'

test.describe('Run View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/run')
  })

  test('displays initial state', async ({ page }) => {
    // Should show the app container
    await expect(page.locator('#csv-import-app')).toBeVisible()
  })

  test('shows progress bar', async ({ page }) => {
    // Progress component should be rendered
    await expect(page.locator('.csv-progress-track')).toBeVisible()
  })

  test('shows files section', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /files/i })).toBeVisible()
  })

  test('has ETA display', async ({ page }) => {
    await expect(page.getByText(/eta/i)).toBeVisible()
  })
})

test.describe('Run - Progress Monitoring', () => {
  test('shows percentage', async ({ page }) => {
    await page.goto('/#/run')

    // Should show 0% or some percentage
    await expect(page.getByText(/%/)).toBeVisible()
  })

  test('shows file count', async ({ page }) => {
    await page.goto('/#/run')

    // Should show "X / Y files" format
    await expect(page.getByText(/\d+\s*\/\s*\d+\s*files/i)).toBeVisible()
  })
})

test.describe('Run - Error Display', () => {
  test('errors section hidden when no errors', async ({ page }) => {
    await page.goto('/#/run')

    // Recent errors section should not be visible initially
    // (or should show 0 errors)
  })
})
