import { defineConfig, devices } from '@playwright/test'

// Embedded (addon) e2e: drives the REAL Odoo web client against a live Odoo
// server (started by CI with QUEUE_JOB__NO_DELAY=1 so imports complete inline).
// The server is managed externally — no webServer here. Point at it with
// ODOO_URL (default http://localhost:8069).
const baseURL = process.env.ODOO_URL || 'http://localhost:8069'

export default defineConfig({
  testDir: './tests/embedded',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
