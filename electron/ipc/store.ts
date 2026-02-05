import { ipcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'

const storePath = path.join(app.getPath('userData'), 'csv-import-store.json')

let storeData: Record<string, unknown> = {}

async function loadStore() {
  try {
    const content = await fs.readFile(storePath, 'utf-8')
    storeData = JSON.parse(content)
  } catch {
    storeData = {}
  }
}

async function saveStore() {
  await fs.writeFile(storePath, JSON.stringify(storeData, null, 2))
}

// Load store on startup
loadStore()

ipcMain.handle('store:get', async (_event, key: string) => {
  return storeData[key] ?? null
})

ipcMain.handle('store:set', async (_event, key: string, value: unknown) => {
  storeData[key] = value
  await saveStore()
})
