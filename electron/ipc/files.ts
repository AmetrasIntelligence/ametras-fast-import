import { ipcMain, dialog, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { createReadStream } from 'fs'
import readline from 'readline'

const fileRegistry = new Map<string, string>()

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
ipcMain.handle('files:read', async (_event, id: string) => {
  const filePath = fileRegistry.get(id)
  if (!filePath) throw new Error(`Unknown file ID: ${id}`)

  return fs.readFile(filePath, 'utf-8')
})

// Read only first N bytes (for analysis)
ipcMain.handle('files:readHead', async (_event, id: string, bytes: number) => {
  const filePath = fileRegistry.get(id)
  if (!filePath) throw new Error(`Unknown file ID: ${id}`)

  const handle = await fs.open(filePath, 'r')
  const buffer = Buffer.alloc(bytes)
  const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
  await handle.close()

  return buffer.toString('utf-8', 0, bytesRead)
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
ipcMain.handle('files:streamChunks', async (event, id: string, chunkLines: number) => {
  const filePath = fileRegistry.get(id)
  if (!filePath) throw new Error(`Unknown file ID: ${id}`)

  const streamId = randomUUID()
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let chunk: string[] = []
  let isFirstChunk = true
  let headerLine = ''

  rl.on('line', (line) => {
    if (isFirstChunk && chunk.length === 0) {
      headerLine = line
    }
    chunk.push(line)

    if (chunk.length >= chunkLines) {
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
