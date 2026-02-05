import { test, expect } from '@playwright/test'

test.describe('Config View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/config')
  })

  test('displays configure import heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /configure import/i })).toBeVisible()
  })

  test('shows import settings button (collapsed by default)', async ({ page }) => {
    // ImportSettings is collapsible and collapsed by default
    await expect(page.getByText(/import settings/i)).toBeVisible()
  })

  test('shows settings summary when collapsed', async ({ page }) => {
    // When collapsed, summary text is shown (e.g., "Batch: 200 | Retries: 3")
    await expect(page.getByText(/Batch: \d+/)).toBeVisible()
  })

  test('expands settings on click', async ({ page }) => {
    // Click the import settings header to expand
    await page.getByText(/import settings/i).click()

    // Settings fields should now be visible
    await expect(page.getByText(/batch size/i)).toBeVisible()
    await expect(page.getByText(/retry limit/i)).toBeVisible()
    await expect(page.getByText(/retry delay/i)).toBeVisible()
    await expect(page.getByText(/stop on fatal error/i)).toBeVisible()
    await expect(page.getByText(/encoding/i)).toBeVisible()
    await expect(page.getByText(/delimiter/i)).toBeVisible()
    await expect(page.getByText(/skip header/i)).toBeVisible()
    await expect(page.getByText(/dry run/i)).toBeVisible()
    await expect(page.getByText(/language/i)).toBeVisible()
  })

  test('has back button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /back/i })).toBeVisible()
  })

  test('has start import button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /start import/i })).toBeVisible()
  })

  test('has save as profile button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /save as profile/i })).toBeVisible()
  })

  test('back button navigates to files', async ({ page }) => {
    await page.getByRole('button', { name: /back/i }).click()
    await expect(page).toHaveURL(/#\/files/)
  })
})

test.describe('Config - Settings Modification', () => {
  test('can change batch size', async ({ page }) => {
    await page.goto('/#/config')

    // Expand settings first
    await page.getByText(/import settings/i).click()

    const batchInput = page.locator('input[type="number"]').first()
    await batchInput.fill('50')

    await expect(batchInput).toHaveValue('50')
  })

  test('can change retry limit', async ({ page }) => {
    await page.goto('/#/config')

    // Expand settings first
    await page.getByText(/import settings/i).click()

    const inputs = page.locator('input[type="number"]')
    const retryInput = inputs.nth(1)
    await retryInput.fill('5')

    await expect(retryInput).toHaveValue('5')
  })
})
