import { test, expect } from '@playwright/test'
import { setEnglishLocale, mockWindowApi } from './helpers'

test.describe('Login Flow', () => {
  test.beforeEach(async ({ page }) => {
    await setEnglishLocale(page)
    await mockWindowApi(page)
    await page.goto('/')
    // Wait for the Vue app to mount and render the login page
    await expect(page.locator('#csv-import-app')).toBeVisible({ timeout: 15000 })
  })

  test('displays login form', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /odoo connection/i })).toBeVisible()
    await expect(page.getByPlaceholder(/mycompany\.odoo\.com/i)).toBeVisible()
    await expect(page.getByPlaceholder(/database name/i)).toBeVisible()
    await expect(page.getByPlaceholder(/admin/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /connect/i })).toBeVisible()
  })

  test('shows validation for empty fields', async ({ page }) => {
    await page.getByRole('button', { name: /connect/i }).click()

    // HTML5 validation should prevent submission — host input is required
    const hostInput = page.getByPlaceholder(/mycompany\.odoo\.com/i)
    await expect(hostInput).toHaveAttribute('required')
  })

  test('can fill login form', async ({ page }) => {
    await page.getByPlaceholder(/mycompany\.odoo\.com/i).fill('test.odoo.com')
    await page.getByPlaceholder(/database name/i).fill('testdb')
    await page.getByPlaceholder(/admin/i).fill('admin')
    await page.getByLabel(/password/i).fill('password123')

    await expect(page.getByPlaceholder(/mycompany\.odoo\.com/i)).toHaveValue('test.odoo.com')
    await expect(page.getByPlaceholder(/database name/i)).toHaveValue('testdb')
  })

  test('shows error on failed login', async ({ page }) => {
    // Override window.api.odoo.authenticate to simulate auth failure
    // (standalone client uses IPC, not HTTP, so page.route has no effect)
    await page.evaluate(() => {
      (window as any).api.odoo.authenticate = async () => ({
        ok: false,
        error: 'Invalid credentials'
      })
    })

    await page.getByPlaceholder(/mycompany\.odoo\.com/i).fill('test.odoo.com')
    await page.getByPlaceholder(/database name/i).fill('testdb')
    await page.getByPlaceholder(/admin/i).fill('admin')
    await page.getByLabel(/password/i).fill('wrongpassword')

    await page.getByRole('button', { name: /connect/i }).click()

    // Should stay on login page with error message
    await expect(page.getByRole('heading', { name: /odoo connection/i })).toBeVisible()
    await expect(page.getByText(/invalid credentials/i)).toBeVisible()
  })

  test('saved connections not visible initially', async ({ page }) => {
    // No saved profiles in a fresh state
    await expect(page.getByText(/saved connections/i)).not.toBeVisible()
  })
})

test.describe('Login - Multi Server', () => {
  test('can switch between server inputs', async ({ page }) => {
    await setEnglishLocale(page)
    await mockWindowApi(page)
    await page.goto('/')
    await expect(page.locator('#csv-import-app')).toBeVisible({ timeout: 15000 })

    // Fill first server
    await page.getByPlaceholder(/mycompany\.odoo\.com/i).fill('server1.odoo.com')
    await page.getByPlaceholder(/database name/i).fill('db1')
    await page.getByPlaceholder(/admin/i).fill('user1')

    // Clear and fill second server
    await page.getByPlaceholder(/mycompany\.odoo\.com/i).fill('server2.odoo.com')
    await expect(page.getByPlaceholder(/mycompany\.odoo\.com/i)).toHaveValue('server2.odoo.com')
  })
})
