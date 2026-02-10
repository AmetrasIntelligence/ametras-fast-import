import { ipcMain, dialog, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { createReadStream } from 'fs'
import readline from 'readline'
import { Buffer } from 'buffer'

const fileRegistry = new Map<string, string>()

/**
 * Validate file path to prevent path traversal attacks.
 */
function validateFilePath(filePath: string): boolean {
  // Check for path traversal patterns and null bytes
  if (filePath.includes('..') || filePath.includes('\0')) {
    return false
  }
  // Ensure it's an absolute path
  if (!path.isAbsolute(filePath)) {
    return false
  }
  return true
}

// Supported encodings mapped to Node.js encoding names
const ENCODING_MAP: Record<string, BufferEncoding> = {
  'utf-8': 'utf-8',
  'utf-8-sig': 'utf-8', // BOM will be stripped separately
  'latin-1': 'latin1',
  'cp1252': 'latin1' // Close approximation
}

/**
 * Strip UTF-8 BOM if present at the start of content.
 */
function stripBOM(content: string): string {
  if (content.charCodeAt(0) === 0xFEFF) {
    return content.slice(1)
  }
  return content
}

/**
 * Detect line ending style from content sample.
 */
function detectLineEnding(content: string): string {
  if (content.includes('\r\n')) return '\r\n'
  if (content.includes('\r')) return '\r'
  return '\n'
}

// Register files by their paths (for drag-and-drop)
ipcMain.handle('files:register', async (_event, filePaths: string[]) => {
  const handles = await Promise.all(
    filePaths
      .filter(filePath => filePath.toLowerCase().endsWith('.csv'))
      .filter(filePath => validateFilePath(filePath)) // Security: validate paths
      .map(async (filePath) => {
        const id = randomUUID()
        const stats = await fs.stat(filePath)

        fileRegistry.set(id, filePath)

        return {
          id,
          name: path.basename(filePath),
          size: stats.size
        }
      })
  )

  return handles
})

ipcMain.handle('files:select', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'CSV Files', extensions: ['csv'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })

  if (canceled) return []

  const handles = await Promise.all(
    filePaths.map(async (filePath) => {
      const id = randomUUID()
      const stats = await fs.stat(filePath)

      fileRegistry.set(id, filePath)

      return {
        id,
        name: path.basename(filePath),
        size: stats.size
      }
    })
  )

  return handles
})

// Full file read (for small files / analysis)
ipcMain.handle('files:read', async (_event, id: string, encoding?: string) => {
  const filePath = fileRegistry.get(id)
  if (!filePath) throw new Error(`Unknown file ID: ${id}`)

  const nodeEncoding = ENCODING_MAP[encoding || 'utf-8'] || 'utf-8'
  let content = await fs.readFile(filePath, nodeEncoding)

  // Strip BOM for utf-8-sig
  if (encoding === 'utf-8-sig' || encoding === 'utf-8') {
    content = stripBOM(content)
  }

  return content
})

// Read only first N bytes (for analysis)
ipcMain.handle('files:readHead', async (_event, id: string, bytes: number, encoding?: string) => {
  const filePath = fileRegistry.get(id)
  if (!filePath) throw new Error(`Unknown file ID: ${id}`)

  const handle = await fs.open(filePath, 'r')
  const buffer = Buffer.alloc(bytes)
  const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
  await handle.close()

  const nodeEncoding = ENCODING_MAP[encoding || 'utf-8'] || 'utf-8'
  let content = buffer.toString(nodeEncoding, 0, bytesRead)

  // Strip BOM for utf-8-sig
  if (encoding === 'utf-8-sig' || encoding === 'utf-8') {
    content = stripBOM(content)
  }

  return content
})

// Count lines efficiently (streaming)
ipcMain.handle('files:countLines', async (_event, id: string) => {
  const filePath = fileRegistry.get(id)
  if (!filePath) throw new Error(`Unknown file ID: ${id}`)

  return new Promise<number>((resolve, reject) => {
    let count = 0
    const stream = createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    rl.on('line', () => count++)
    rl.on('close', () => resolve(count))
    rl.on('error', reject)
  })
})

// Stream file in chunks for processing
ipcMain.handle('files:streamChunks', async (event, id: string, chunkLines: number, encoding?: string) => {
  const filePath = fileRegistry.get(id)
  if (!filePath) throw new Error(`Unknown file ID: ${id}`)

  const streamId = randomUUID()
  const nodeEncoding = ENCODING_MAP[encoding || 'utf-8'] || 'utf-8'
  const stream = createReadStream(filePath, { encoding: nodeEncoding })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let chunk: string[] = []
  let isFirstChunk = true
  let headerLine = ''
  let lineEnding = '\n' // Default, will be detected from first line
  let bomStripped = false

  rl.on('line', (line) => {
    let processedLine = line

    // Strip BOM from first line if present
    if (isFirstChunk && chunk.length === 0 && !bomStripped) {
      processedLine = stripBOM(line)
      bomStripped = true

      // Detect line ending from raw file content (check first few KB)
      // We use \n as default since readline strips endings, but we'll
      // use \n universally for CSV parsing (PapaParse handles both)
    }

    if (isFirstChunk && chunk.length === 0) {
      headerLine = processedLine
    }
    chunk.push(processedLine)

    if (chunk.length >= chunkLines) {
      // Use \n for joining - PapaParse handles line endings internally
      const data = isFirstChunk ? chunk.join('\n') : headerLine + '\n' + chunk.join('\n')
      event.sender.send(`files:chunk:${streamId}`, { data, done: false })
      chunk = []
      isFirstChunk = false
    }
  })

  rl.on('close', () => {
    if (chunk.length > 0) {
      const data = isFirstChunk ? chunk.join('\n') : headerLine + '\n' + chunk.join('\n')
      event.sender.send(`files:chunk:${streamId}`, { data, done: false })
    }
    event.sender.send(`files:chunk:${streamId}`, { data: '', done: true })
  })

  rl.on('error', (err) => {
    event.sender.send(`files:chunk:${streamId}`, { error: err.message, done: true })
  })

  return streamId
})

export function clearFileRegistry() {
  fileRegistry.clear()
}
