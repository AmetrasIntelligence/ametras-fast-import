import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { getSession } from './odoo'

export interface ProfileUploadResult {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

// Select a ZIP file via dialog
ipcMain.handle('profile:selectZip', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'ZIP Files', extensions: ['zip'] }
    ]
  })

  if (canceled || filePaths.length === 0) return null

  const filePath = filePaths[0]
  return {
    path: filePath,
    name: path.basename(filePath)
  }
})

// Upload a ZIP file to Odoo via multipart POST
ipcMain.handle('profile:upload', async (_event, payload: {
  baseUrl: string
  filePath: string
}): Promise<ProfileUploadResult> => {
  try {
    const { baseUrl, filePath } = payload
    const session = getSession(baseUrl)

    if (!session) {
      return { ok: false, error: 'Not authenticated' }
    }

    const fileBuffer = await fs.readFile(filePath)
    const fileName = path.basename(filePath)

    // Build multipart form data manually
    const boundary = '----FormBoundary' + Date.now().toString(36)
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`
    const footer = `\r\n--${boundary}--\r\n`

    const headerBuf = Buffer.from(header, 'utf-8')
    const footerBuf = Buffer.from(footer, 'utf-8')
    const body = Buffer.concat([headerBuf, fileBuffer, footerBuf])

    const response = await fetch(`${baseUrl}/csv_import/profile/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Cookie': `session_id=${session.sessionId}`
      },
      body
    })

    const data = await response.json() as ProfileUploadResult

    if (!data.ok) {
      return { ok: false, error: data.error || 'Upload failed' }
    }

    return { ok: true, result: data.result }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Upload failed'
    return { ok: false, error: message }
  }
})

// Download/export a profile ZIP from Odoo
ipcMain.handle('profile:export', async (_event, payload: {
  baseUrl: string
  profileId: number
  profileName: string
}): Promise<boolean> => {
  try {
    const { baseUrl, profileId, profileName } = payload
    const session = getSession(baseUrl)

    if (!session) {
      throw new Error('Not authenticated')
    }

    const safeName = profileName.replace(/[^a-zA-Z0-9_-]/g, '_')

    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `${safeName}.zip`,
      filters: [
        { name: 'ZIP Files', extensions: ['zip'] }
      ]
    })

    if (canceled || !filePath) return false

    const response = await fetch(
      `${baseUrl}/csv_import/profile/${profileId}/export`,
      {
        method: 'GET',
        headers: {
          'Cookie': `session_id=${session.sessionId}`
        }
      }
    )

    if (!response.ok) {
      throw new Error(`Export failed: ${response.statusText}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    await fs.writeFile(filePath, Buffer.from(arrayBuffer))

    return true
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Export failed'
    throw new Error(message)
  }
})
