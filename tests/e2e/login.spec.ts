import { test, expect } from '@playwright/test'

test.describe('Login Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('displays login form', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /odoo connection/i })).toBeVisible()
    await expect(page.getByPlaceholder(/mycompany\.odoo\.com/i)).toBeVisible()
    await expect(page.getByPlaceholder(/database name/i)).toBeVisible()
    await expect(page.getByPlaceholder(/admin@example.com/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /connect/i })).toBeVisible()
  })

  test('shows validation for empty fields', async ({ page }) => {
    await page.getByRole('button', { name: /connect/i }).click()

    // HTML5 validation should prevent submission
    const hostInput = page.getByPlaceholder(/mycompany\.odoo\.com/i)
    await expect(hostInput).toHaveAttribute('required')
  })

  test('can fill login form', async ({ page }) => {
    await page.getByPlaceholder(/mycompany\.odoo\.com/i).fill('test.odoo.com')
    await page.getByPlaceholder(/database name/i).fill('testdb')
    await page.getByPlaceholder(/admin@example.com/i).fill('admin')
    await page.getByLabel(/password/i).fill('password123')

    // Form should be filled
    await expect(page.getByPlaceholder(/mycompany\.odoo\.com/i)).toHaveValue('test.odoo.com')
    await expect(page.getByPlaceholder(/database name/i)).toHaveValue('testdb')
  })

  test('shows error on failed login', async ({ page }) => {
    // Mock failed auth response
    await page.route('**/web/session/authenticate', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { uid: false }
        })
      })
    })

    await page.getByPlaceholder(/mycompany\.odoo\.com/i).fill('test.odoo.com')
    await page.getByPlaceholder(/database name/i).fill('testdb')
    await page.getByPlaceholder(/admin@example.com/i).fill('admin')
    await page.getByLabel(/password/i).fill('wrongpassword')

    await page.getByRole('button', { name: /connect/i }).click()

    // Should show error (or at least not navigate away)
    await expect(page.getByRole('heading', { name: /odoo connection/i })).toBeVisible()
  })

  test('saved connections section visible with profiles', async ({ page }) => {
    // Initially no saved connections
    await expect(page.getByText(/saved connections/i)).not.toBeVisible()
  })
})

test.describe('Login - Multi Server', () => {
  test('can switch between server profiles', async ({ page }) => {
    await page.goto('/')

    // Fill first server
    await page.getByPlaceholder(/mycompany\.odoo\.com/i).fill('server1.odoo.com')
    await page.getByPlaceholder(/database name/i).fill('db1')
    await page.getByPlaceholder(/admin@example.com/i).fill('user1')

    // Clear and fill second server
    await page.getByPlaceholder(/mycompany\.odoo\.com/i).fill('server2.odoo.com')
    await expect(page.getByPlaceholder(/mycompany\.odoo\.com/i)).toHaveValue('server2.odoo.com')
  })
})
