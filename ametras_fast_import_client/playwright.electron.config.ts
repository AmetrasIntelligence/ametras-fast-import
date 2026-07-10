import { defineConfig } from '@playwright/test'

// Standalone Electron e2e (APX-3842): launches the REAL built app via
// Playwright's _electron and drives the REAL bundled Python engine. There is no
// baseURL/webServer — the app is launched in-test. Heaviest suite; runs
// release-gated in CI (under xvfb).
export default defineConfig({
  testDir: './tests/electron',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 120_000,
  expect: { timeout: 30_000 },
})
