import { test, expect, _electron as electron, type Page } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// APX-3842 — the definitive test for the multi-file class of bug (the 2.2.0
// concurrent-analysis deadlock): launch the REAL standalone app and analyze
// SEVERAL CSVs through the REAL bundled Python subprocess. Analysis is local
// (no Odoo), so we stub only the native file dialog + offline login; the engine
// is real.

const CSVS: Record<string, string> = {
  'partners.csv': 'name,email\nAlice,alice@example.com\nBob,bob@example.com\n',
  'products.csv': 'name,ref\nWidget,W1\nGadget,G1\n',
  'tags.csv': 'name,note\nGold,shiny\nSilver,shinier\n',
}

let app: Awaited<ReturnType<typeof electron.launch>>
let win: Page

test.beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-electron-e2e-'))
  const csvPaths = Object.entries(CSVS).map(([name, content]) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, content)
    return p
  })

  app = await electron.launch({
    // --no-sandbox is required to launch Electron on CI Linux runners.
    args: [path.join(process.cwd(), 'dist-electron', 'main.js'), '--no-sandbox'],
  })

  // Main-process stubs: the native file dialog returns our CSVs, and login
  // succeeds offline (analysis needs no server). The Python engine is NOT
  // stubbed — the real subprocess analyzes the files.
  await app.evaluate(async ({ dialog, ipcMain }, files) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: files })
    const stub = (channel: string, result: unknown) => {
      try {
        ipcMain.removeHandler(channel)
      } catch {
        /* not registered yet */
      }
      ipcMain.handle(channel, async () => result)
    }
    stub('odoo:authenticate', { ok: true, uid: 1, session_id: 'test', server_version: '16.0' })
    stub('odoo:getEncryptionInfo', { available: false, platform: 'test' })
  }, csvPaths)

  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
})

test('several CSVs analyze via the real bundled engine (none stuck)', async () => {
  // Log in (auth stubbed) to reach the import view. Locale-agnostic selectors.
  await win.locator('#csv-host').fill('localhost')
  await win.locator('#csv-database').fill('testdb')
  await win.locator('#csv-username').fill('admin')
  await win.locator('#csv-password').fill('admin')
  await win.locator('button[type="submit"]').click()

  await expect(win.locator('.csv-drop-zone')).toBeVisible({ timeout: 30_000 })

  // Browse → stubbed dialog returns the 3 CSVs → the real bundled engine
  // analyzes them one at a time.
  await win.locator('.csv-drop-zone__browse').first().click()

  for (const name of Object.keys(CSVS)) {
    await expect(win.getByText(name)).toBeVisible({ timeout: 30_000 })
  }
  await expect(win.locator('.csv-file-list__item')).toHaveCount(3)

  // Every file reaches "ready": no lingering uploading/analyzing/error chip.
  // Pre-2.2.1 (concurrent analysis) left files 2+ stuck 'analysing' here.
  await expect(win.locator('.csv-file-list__state')).toHaveCount(0, { timeout: 60_000 })
})
