import { ipcMain, app } from 'electron'
import fs from 'fs/promises'
import { readFileSync } from 'fs'
import path from 'path'

const storePath = path.join(app.getPath('userData'), 'csv-import-store.json')

let storeData: Record<string, unknown> = {}

// Load store synchronously on startup so data is available before IPC handlers fire
try {
  const content = readFileSync(storePath, 'utf-8')
  storeData = JSON.parse(content)
} catch {
  storeData = {}
}

async function saveStore() {
  await fs.writeFile(storePath, JSON.stringify(storeData, null, 2))
}

ipcMain.handle('store:get', async (_event, key: string) => {
  return storeData[key] ?? null
})

ipcMain.handle('store:set', async (_event, key: string, value: unknown) => {
  storeData[key] = value
  try {
    await saveStore()
  } catch (e) {
    // Roll back in-memory state on disk write failure
    delete storeData[key]
    throw e
  }
})
