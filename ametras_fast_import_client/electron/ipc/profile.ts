import { ipcMain, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { getSession } from './odoo'

export interface ProfileUploadResult {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

/**
 * Validate URL is a proper HTTP(S) URL to prevent SSRF and injection attacks.
 */
function validateBaseUrl(baseUrl: string): { valid: boolean; error?: string } {
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' }
    }
    return { valid: true }
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }
}

/**
 * Validate file path to prevent path traversal attacks.
 */
function validateFilePath(filePath: string): { valid: boolean; error?: string } {
  // Check for path traversal patterns
  if (filePath.includes('..') || filePath.includes('\0')) {
    return { valid: false, error: 'Invalid file path' }
  }

  // Ensure it's an absolute path
  if (!path.isAbsolute(filePath)) {
    return { valid: false, error: 'File path must be absolute' }
  }

  return { valid: true }
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
  db?: string
  filePath: string
}): Promise<ProfileUploadResult> => {
  const urlCheck = validateBaseUrl(payload.baseUrl)
  if (!urlCheck.valid) {
    return { ok: false, error: urlCheck.error }
  }

  const pathCheck = validateFilePath(payload.filePath)
  if (!pathCheck.valid) {
    return { ok: false, error: pathCheck.error }
  }

  try {
    const { baseUrl, filePath } = payload
    const session = getSession(baseUrl, payload.db)

    if (!session) {
      return { ok: false, error: 'Not authenticated' }
    }

    const fileBuffer = await fs.readFile(filePath)
    // Sanitize filename for multipart header (strip quotes and control chars)
    const fileName = path.basename(filePath).replace(/["\\\r\n]/g, '_')

    // Build multipart form data manually
    const boundary = '----FormBoundary' + Date.now().toString(36)
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`
    const footer = `\r\n--${boundary}--\r\n`

    const headerBuf = Buffer.from(header, 'utf-8')
    const footerBuf = Buffer.from(footer, 'utf-8')
    const body = Buffer.concat([headerBuf, fileBuffer, footerBuf])

    const response = await fetch(`${baseUrl}/ametras_fast_import/profile/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Cookie': `session_id=${session.sessionId}`
      },
      body,
      signal: AbortSignal.timeout(120_000) // 2 min for file uploads
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
  db?: string
  profileId: number
  profileName: string
}): Promise<{ ok: boolean; error?: string }> => {
  const urlCheck = validateBaseUrl(payload.baseUrl)
  if (!urlCheck.valid) {
    return { ok: false, error: urlCheck.error }
  }

  try {
    const { baseUrl, profileId, profileName } = payload
    const session = getSession(baseUrl, payload.db)

    if (!session) {
      return { ok: false, error: 'Not authenticated' }
    }

    const safeName = profileName.replace(/[^a-zA-Z0-9_-]/g, '_')

    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `${safeName}.zip`,
      filters: [
        { name: 'ZIP Files', extensions: ['zip'] }
      ]
    })

    if (canceled || !filePath) return { ok: false }

    const response = await fetch(
      `${baseUrl}/ametras_fast_import/profile/${profileId}/export`,
      {
        method: 'GET',
        headers: {
          'Cookie': `session_id=${session.sessionId}`
        },
        signal: AbortSignal.timeout(120_000) // 2 min for file downloads
      }
    )

    if (!response.ok) {
      return { ok: false, error: `Export failed: ${response.statusText}` }
    }

    const arrayBuffer = await response.arrayBuffer()
    await fs.writeFile(filePath, Buffer.from(arrayBuffer))

    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Export failed'
    return { ok: false, error: message }
  }
})
