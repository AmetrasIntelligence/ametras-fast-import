import { test, expect } from '@playwright/test'
import { mockLogin } from './helpers'

test.describe('Results View', () => {
  test.beforeEach(async ({ page }) => {
    await mockLogin(page)
    await page.goto('/#/results')
  })

  test('displays import complete heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /import complete/i })).toBeVisible()
  })

  test('shows summary statistics', async ({ page }) => {
    await expect(page.getByText(/total rows/i)).toBeVisible()
    await expect(page.getByText(/successful/i)).toBeVisible()
    await expect(page.getByText(/failed/i).first()).toBeVisible()
    await expect(page.getByText(/duration/i)).toBeVisible()
  })

  // Note: the Export card (error-log / failed-rows-ZIP downloads) only renders
  // when the run produced row errors (v-if="run.errors.length > 0"), so it is
  // intentionally not asserted here in the no-error summary state.

  test('has start new import button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /start new import/i })).toBeVisible()
  })

  test('start new import navigates to import view', async ({ page }) => {
    await page.getByRole('button', { name: /start new import/i }).click()
    await expect(page).toHaveURL(/#\/import/)
  })
})

test.describe('Results - Error Display', () => {
  test('errors section hidden when no errors', async ({ page }) => {
    await mockLogin(page)
    await page.goto('/#/results')

    // Errors section only shows when run.errors.length > 0
    // With no import run, there are no errors
    await expect(page.getByRole('heading', { name: /^errors/i })).not.toBeVisible()
  })
})
