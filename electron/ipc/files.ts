import { ipcMain, dialog, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { createReadStream, realpathSync } from 'fs'
import readline from 'readline'
import { Buffer } from 'buffer'

const fileRegistry = new Map<string, string>()

/**
 * Validate file path to prevent path traversal attacks.
 * - Checks for path traversal patterns and null bytes
 * - Ensures path is absolute
 * - Resolves symlinks to get real path
 * - Verifies file exists and is a regular file
 */
async function validateFilePath(filePath: string): Promise<{ valid: boolean; resolvedPath?: string; error?: string }> {
  // Check for null bytes (potential injection)
  if (filePath.includes('\0')) {
    return { valid: false, error: 'Path contains null bytes' }
  }

  // Ensure it's an absolute path
  if (!path.isAbsolute(filePath)) {
    return { valid: false, error: 'Path must be absolute' }
  }

  // Check for obvious path traversal patterns
  if (filePath.includes('..')) {
    return { valid: false, error: 'Path contains traversal patterns' }
  }

  try {
    // Resolve symlinks to get the real path
    const resolvedPath = realpathSync(filePath)

    // Verify file exists and is a regular file
    const stats = await fs.stat(resolvedPath)
    if (!stats.isFile()) {
      return { valid: false, error: 'Path is not a regular file' }
    }

    return { valid: true, resolvedPath }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Path validation failed'
    return { valid: false, error: message }
  }
}

/**
 * Synchronous path validation for simple checks (used in filters).
 * For full validation including symlink resolution, use validateFilePath().
 */
function validateFilePathSync(filePath: string): boolean {
  // Quick checks only - full validation happens in async version
  if (filePath.includes('\0') || filePath.includes('..') || !path.isAbsolute(filePath)) {
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
  const handles: Array<{ id: string; name: string; size: number }> = []

  for (const filePath of filePaths) {
    // Quick sync check first
    if (!filePath.toLowerCase().endsWith('.csv')) continue
    if (!validateFilePathSync(filePath)) continue

    // Full async validation with symlink resolution
    const validation = await validateFilePath(filePath)
    if (!validation.valid || !validation.resolvedPath) {
      console.warn(`[files] Rejected path: ${filePath} - ${validation.error}`)
      continue
    }

    const id = randomUUID()
    const stats = await fs.stat(validation.resolvedPath)

    // Store the resolved (real) path, not the symlinked path
    fileRegistry.set(id, validation.resolvedPath)

    handles.push({
      id,
      name: path.basename(filePath),  // Keep original name for display
      size: stats.size
    })
  }

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

  const handles: Array<{ id: string; name: string; size: number }> = []

  for (const filePath of filePaths) {
    // Validate even dialog-selected paths (defense in depth)
    const validation = await validateFilePath(filePath)
    if (!validation.valid || !validation.resolvedPath) {
      console.warn(`[files:select] Rejected path: ${filePath} - ${validation.error}`)
      continue
    }

    const id = randomUUID()
    const stats = await fs.stat(validation.resolvedPath)

    // Store the resolved (real) path, not the potentially symlinked path
    fileRegistry.set(id, validation.resolvedPath)

    handles.push({
      id,
      name: path.basename(filePath),  // Keep original name for display
      size: stats.size
    })
  }

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
  const lineEnding = '\n' // Default, will be detected from first line
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

/**
 * Async streaming with backpressure support.
 * Uses request-reply pattern: renderer requests each chunk, processes it,
 * then requests next. Prevents memory buildup from fast streaming.
 */
const activeStreams = new Map<string, {
  rl: readline.Interface
  headerLine: string
  buffer: string[][]
  done: boolean
  error?: string
}>()

ipcMain.handle('files:streamStart', async (_event, id: string, chunkLines: number, encoding?: string) => {
  const filePath = fileRegistry.get(id)
  if (!filePath) throw new Error(`Unknown file ID: ${id}`)

  const streamId = randomUUID()
  const nodeEncoding = ENCODING_MAP[encoding || 'utf-8'] || 'utf-8'
  const stream = createReadStream(filePath, { encoding: nodeEncoding })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  const state = {
    rl,
    headerLine: '',
    buffer: [] as string[][],
    done: false,
    error: undefined as string | undefined
  }

  let currentChunk: string[] = []
  let isFirstLine = true
  let bomStripped = false

  rl.on('line', (line) => {
    let processedLine = line

    // Strip BOM from first line if present
    if (isFirstLine && !bomStripped) {
      processedLine = stripBOM(line)
      bomStripped = true
      state.headerLine = processedLine
      isFirstLine = false
    }

    currentChunk.push(processedLine)

    if (currentChunk.length >= chunkLines) {
      state.buffer.push(currentChunk)
      currentChunk = []
      // Pause stream if buffer gets too large (backpressure)
      if (state.buffer.length >= 3) {
        rl.pause()
      }
    }
  })

  rl.on('close', () => {
    if (currentChunk.length > 0) {
      state.buffer.push(currentChunk)
    }
    state.done = true
  })

  rl.on('error', (err) => {
    state.error = err.message
    state.done = true
  })

  activeStreams.set(streamId, state)
  return streamId
})

ipcMain.handle('files:streamNext', async (_event, streamId: string) => {
  const state = activeStreams.get(streamId)
  if (!state) throw new Error(`Unknown stream ID: ${streamId}`)

  // Wait for data if buffer empty and not done
  while (state.buffer.length === 0 && !state.done) {
    state.rl.resume()
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  if (state.error) {
    activeStreams.delete(streamId)
    return { error: state.error, done: true }
  }

  if (state.buffer.length > 0) {
    const chunk = state.buffer.shift()!
    const isFirstChunk = chunk[0] === state.headerLine
    const data = isFirstChunk ? chunk.join('\n') : state.headerLine + '\n' + chunk.join('\n')

    // Resume stream if buffer low
    if (state.buffer.length < 2) {
      state.rl.resume()
    }

    return { data, done: false }
  }

  // Done
  activeStreams.delete(streamId)
  return { data: '', done: true }
})

ipcMain.handle('files:streamClose', async (_event, streamId: string) => {
  const state = activeStreams.get(streamId)
  if (state) {
    state.rl.close()
    activeStreams.delete(streamId)
  }
})

export function clearFileRegistry() {
  fileRegistry.clear()
  // Clean up any active streams
  for (const [, state] of activeStreams) {
    state.rl.close()
  }
  activeStreams.clear()
}
