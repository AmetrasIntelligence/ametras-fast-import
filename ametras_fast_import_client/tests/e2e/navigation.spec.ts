import { test, expect } from '@playwright/test'
import { mockLogin, mockWindowApi, setEnglishLocale } from './helpers'

test.describe('Navigation - Public Routes', () => {
  test('redirects root to login', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/#\/login/)
  })

  test('login page accessible without auth', async ({ page }) => {
    await setEnglishLocale(page)
    await mockWindowApi(page)
    await page.goto('/#/login')
    await expect(page.locator('#csv-import-app')).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('heading', { name: /odoo connection/i })).toBeVisible()
  })
})

test.describe('Navigation - Auth Guard', () => {
  test('redirects protected routes to login when unauthenticated', async ({ page }) => {
    await page.goto('/#/import')
    await expect(page).toHaveURL(/#\/login/)
  })

  test('allows access to import after login', async ({ page }) => {
    await mockLogin(page)
    await expect(page).toHaveURL(/#\/import/)
    await expect(page.getByRole('heading', { name: /^import$/i })).toBeVisible()
  })
})

test.describe('Navigation - Authenticated Routes', () => {
  test.beforeEach(async ({ page }) => {
    await mockLogin(page)
  })

  test('can navigate to import view', async ({ page }) => {
    await page.goto('/#/import')
    await expect(page.getByRole('heading', { name: /^import$/i })).toBeVisible()
  })

  test('can navigate to profiles view', async ({ page }) => {
    await page.goto('/#/profiles')
    await expect(page.getByRole('heading', { name: /import profiles/i })).toBeVisible()
  })

  test('can navigate to run view', async ({ page }) => {
    await page.goto('/#/run')
    await expect(page.locator('#csv-import-app')).toBeVisible()
  })

  test('can navigate to results view', async ({ page }) => {
    await page.goto('/#/results')
    await expect(page.getByRole('heading', { name: /import complete/i })).toBeVisible()
  })

  test('backward compat: /files redirects to /import', async ({ page }) => {
    await page.goto('/#/files')
    await expect(page).toHaveURL(/#\/import/)
  })

  test('backward compat: /config redirects to /import', async ({ page }) => {
    await page.goto('/#/config')
    await expect(page).toHaveURL(/#\/import/)
  })

  test('backward compat: /mappings redirects to /profiles', async ({ page }) => {
    await page.goto('/#/mappings')
    await expect(page).toHaveURL(/#\/profiles/)
  })
})
