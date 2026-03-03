import { test, expect } from '@playwright/test'
import { mockLogin } from './helpers'

test.describe('Run View', () => {
  test.beforeEach(async ({ page }) => {
    await mockLogin(page)
    await page.goto('/#/run')
  })

  test('displays initial state', async ({ page }) => {
    // App container should be visible
    await expect(page.locator('#csv-import-app')).toBeVisible()
  })

  test('shows state label', async ({ page }) => {
    // Default state is "Ready" (IDLE state)
    await expect(page.getByRole('heading', { name: /ready/i })).toBeVisible()
  })

  test('shows progress bar', async ({ page }) => {
    // Progress component renders with role="progressbar"
    await expect(page.getByRole('progressbar')).toBeVisible()
  })

  test('shows files section', async ({ page }) => {
    // Files table heading
    await expect(page.getByRole('heading', { name: /^files$/i })).toBeVisible()
  })

  test('shows ETA display', async ({ page }) => {
    // ETA label is always visible in the run view
    await expect(page.getByText(/eta/i)).toBeVisible()
  })

  test('shows percentage display', async ({ page }) => {
    // Should show 0% in idle state
    await expect(page.getByText(/0%/)).toBeVisible()
  })

  test('shows file count', async ({ page }) => {
    // Shows "0 / 0 files" when no import is running
    await expect(page.getByText(/\d+\s*\/\s*\d+\s*files/i)).toBeVisible()
  })
})

test.describe('Run - Error Display', () => {
  test('errors section hidden when no errors', async ({ page }) => {
    await mockLogin(page)
    await page.goto('/#/run')

    // Recent errors section only visible when errors exist (v-if="run.errors.length > 0")
    await expect(page.getByText(/recent errors/i)).not.toBeVisible()
  })
})
