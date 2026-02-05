import { test, expect } from '@playwright/test'

test.describe('Navigation', () => {
  test('redirects root to login', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/#\/login/)
  })

  test('can navigate through all views', async ({ page }) => {
    // Login
    await page.goto('/#/login')
    await expect(page.getByRole('heading', { name: /odoo connection/i })).toBeVisible()

    // Files
    await page.goto('/#/files')
    await expect(page.getByRole('heading', { name: /select csv files/i })).toBeVisible()

    // Config
    await page.goto('/#/config')
    await expect(page.getByRole('heading', { name: /configure import/i })).toBeVisible()

    // Run
    await page.goto('/#/run')
    await expect(page.locator('#csv-import-app')).toBeVisible()

    // Results
    await page.goto('/#/results')
    await expect(page.getByRole('heading', { name: /import complete/i })).toBeVisible()

    // Saved Mappings
    await page.goto('/#/mappings')
    await expect(page.getByRole('heading', { name: /saved mappings/i })).toBeVisible()
  })
})

test.describe('Full Import Flow Navigation', () => {
  test('workflow: files -> config -> run -> results', async ({ page }) => {
    // Start at files
    await page.goto('/#/files')
    await expect(page.getByRole('heading', { name: /select csv files/i })).toBeVisible()

    // Navigate to config (would normally click after selecting files)
    await page.goto('/#/config')
    await expect(page.getByRole('heading', { name: /configure import/i })).toBeVisible()

    // Start import button should be visible (may be disabled without files)
    await expect(page.getByRole('button', { name: /start import/i })).toBeVisible()

    // After completion would navigate to results
    await page.goto('/#/results')
    await expect(page.getByRole('heading', { name: /import complete/i })).toBeVisible()
  })

  test('can go back from config to files', async ({ page }) => {
    await page.goto('/#/config')
    await page.getByRole('button', { name: /back/i }).click()
    await expect(page).toHaveURL(/#\/files/)
  })

  test('can start new import from results', async ({ page }) => {
    await page.goto('/#/results')
    await page.getByRole('button', { name: /start new import/i }).click()
    await expect(page).toHaveURL(/#\/files/)
  })

  test('can navigate to saved mappings', async ({ page }) => {
    await page.goto('/#/mappings')
    await expect(page.getByRole('heading', { name: /saved mappings/i })).toBeVisible()
    await expect(page.getByText(/no saved mappings yet/i)).toBeVisible()
  })
})
