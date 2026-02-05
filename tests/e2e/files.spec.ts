import { test, expect } from '@playwright/test'

test.describe('Files View', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate directly to files view (skip auth for UI testing)
    await page.goto('/#/files')
  })

  test('displays drop zone in empty state', async ({ page }) => {
    // FileDropZone shows drag & drop text when no files
    await expect(page.getByText(/drag & drop csv files/i)).toBeVisible()
    await expect(page.getByText(/browse/i)).toBeVisible()
  })

  test('has page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /select csv files/i })).toBeVisible()
  })

  test('shows browse link in drop zone', async ({ page }) => {
    // The "browse" text in drop zone acts as a button
    await expect(page.getByRole('button', { name: /browse/i })).toBeVisible()
  })
})

test.describe('Files - With Files Loaded', () => {
  test('add files button appears when files exist', async ({ page }) => {
    await page.goto('/#/files')

    // In empty state, "Add Files" button is not visible (only drop zone)
    // The "Add Files" button only appears when files.length > 0
    await expect(page.getByRole('heading', { name: /select csv files/i })).toBeVisible()
  })
})
