/**
 * Python subprocess IPC handler.
 *
 * Spawns the import_engine Python package as a subprocess and communicates
 * via JSON lines over stdin/stdout. This gives Electron full import
 * capabilities (search keys, __op__, dry-run, etc.) without requiring
 * the Odoo addon to be installed.
 *
 * Python detection priority:
 * 1. Bundled runtime (packaged app resources, or downloaded dev runtime)
 * 2. System python3 on PATH
 * 3. Falls back to model.load() standalone mode (handled by caller)
 */
import { ipcMain, app } from 'electron'
import { spawn, exec, execFile, ChildProcess } from 'child_process'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { getCredentials, getSession } from './odoo'
import { getFilePath } from './files'

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Path to the import_engine package:
// - Dev: relative to electron/ dir → ../../ametras_fast_import_addon/models
// - Packaged: extraResources → <app>/Contents/Resources/import_engine
const ENGINE_DEV_PATH = '../../ametras_fast_import_addon/models'

let pythonProcess: ChildProcess | null = null
let rl: readline.Interface | null = null
let pendingResolve: ((msg: Record<string, unknown>) => void) | null = null
let pendingTimeoutReset: (() => void) | null = null
let messageQueue: Record<string, unknown>[] = []

function getRuntimeArch(): 'x64' | 'arm64' | null {
  switch (process.arch) {
    case 'x64':
    case 'arm64':
      return process.arch
    default:
      return null
  }
}

function getBundledPythonCandidates(): string[] {
  const candidates: string[] = []

  if (app.isPackaged) {
    if (process.platform === 'win32') {
      candidates.push(path.join(process.resourcesPath, 'python-runtime', 'python.exe'))
    } else {
      candidates.push(
        path.join(process.resourcesPath, 'python-runtime', 'bin', 'python3'),
        path.join(process.resourcesPath, 'python-runtime', 'bin', 'python'),
        path.join(process.resourcesPath, 'python-runtime', 'bin', 'python3.12'),
      )
    }

    return candidates
  }

  const runtimeArch = getRuntimeArch()
  if (!runtimeArch) {
    return candidates
  }

  const runtimeRoot = path.resolve(__dirname, `../../python-runtime/${process.platform}-${runtimeArch}`)
  if (process.platform === 'win32') {
    candidates.push(path.join(runtimeRoot, 'python.exe'))
  } else {
    candidates.push(
      path.join(runtimeRoot, 'bin', 'python3'),
      path.join(runtimeRoot, 'bin', 'python'),
      path.join(runtimeRoot, 'bin', 'python3.12'),
    )
  }

  return candidates
}

/**
 * Detect available Python executable.
 * Returns the path to python3 or null if not found.
 */
/**
 * Try to find python3 via the user's shell (works on macOS/Linux/Windows).
 * exec() spawns a shell, so it inherits the full PATH — unlike execFile().
 */
function findPythonViaShell(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const findCmd = process.platform === 'win32'
        ? `where ${cmd}`
        : `which ${cmd}`

      exec(findCmd, { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null)
        } else {
          resolve(stdout.trim().split('\n')[0].trim())
        }
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * Verify a Python path is valid and >= 3.8.
 */
function verifyPython(pythonPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(pythonPath, ['--version'], { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
          resolve(false)
        } else {
          const output = stdout || stderr || ''
          const match = output.match(/Python (\d+)\.(\d+)/)
          if (match) {
            const major = parseInt(match[1])
            const minor = parseInt(match[2])
            resolve(major >= 3 && (major > 3 || minor >= 8))
          } else {
            resolve(false)
          }
        }
      })
    } catch {
      // execFile can throw synchronously (ENOTDIR, EACCES) in sandboxed environments
      resolve(false)
    }
  })
}

async function detectPython(): Promise<string | null> {
  // 1. Check for bundled Python runtime
  for (const bundled of getBundledPythonCandidates()) {
    if (await verifyPython(bundled)) {
      console.log(`[python] Found bundled Python at: ${bundled}`)
      return bundled
    }
  }

  // 2. Find python3/python via the user's shell PATH.
  // This works on all platforms — exec() runs through the shell,
  // which inherits the full user PATH (unlike execFile in GUI apps).
  for (const cmd of ['python3', 'python']) {
    const found = await findPythonViaShell(cmd)
    if (found && await verifyPython(found)) {
      console.log(`[python] Found Python via shell: ${found}`)
      return found
    }
  }

  // 3. Check well-known locations directly (fallback for restricted shells)
  const knownPaths = process.platform === 'win32'
    ? [
        'C:\\Python312\\python.exe',
        'C:\\Python311\\python.exe',
        'C:\\Python310\\python.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
      ]
    : [
        '/opt/homebrew/bin/python3',          // macOS Homebrew Apple Silicon
        '/usr/local/bin/python3',             // macOS Homebrew Intel / Linux manual
        '/usr/bin/python3',                   // macOS system / Linux system
        path.join(process.env.HOME || '', '.pyenv', 'shims', 'python3'),
      ]

  // Prepend VIRTUAL_ENV if active (e.g., launched from terminal with venv)
  if (process.env.VIRTUAL_ENV) {
    const venvPython = path.join(
      process.env.VIRTUAL_ENV,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python3'
    )
    knownPaths.unshift(venvPython)
  }

  for (const pythonPath of knownPaths) {
    if (await verifyPython(pythonPath)) {
      console.log(`[python] Found Python at known path: ${pythonPath}`)
      return pythonPath
    }
  }

  console.warn('[python] Python >= 3.8 not found')
  return null
}

/**
 * Get the parent directory containing the import_engine package.
 * The subprocess runs as `python -m import_engine` with cwd set to this path.
 */
function getEnginePath(): string {
  // Packaged app: extraResources puts import_engine/ under Resources/
  if (app.isPackaged) {
    // process.resourcesPath = <app>/Contents/Resources (macOS) or resources/ (Win/Linux)
    return process.resourcesPath
  }
  // Development: relative to the compiled electron dir
  return path.resolve(__dirname, ENGINE_DEV_PATH)
}

/**
 * Start the Python subprocess.
 */
function startPythonProcess(pythonPath: string): ChildProcess {
  const enginePath = getEnginePath()
  const proc = spawn(pythonPath, ['-m', 'import_engine'], {
    cwd: enginePath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  })

  // Read JSON lines from stdout
  rl = readline.createInterface({ input: proc.stdout! })
  rl.on('line', (line: string) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>
      if (pendingResolve) {
        // If someone is waiting for a terminal message, check if this is it
        const type = msg.type as string
        if (type === 'done' || type === 'error' || type === 'auth_ok' ||
            type === 'pong' || type === 'models' || type === 'fields' ||
            type === 'analysis' || type === 'cancelled') {
          const resolve = pendingResolve
          pendingResolve = null
          resolve(msg)
        } else {
          // Progress messages — queue for event forwarding
          messageQueue.push(msg)
          // Reset the safety timeout — subprocess is still alive
          if (pendingTimeoutReset) pendingTimeoutReset()
        }
      } else {
        messageQueue.push(msg)
      }
    } catch {
      // Ignore non-JSON lines (e.g., Python warnings)
    }
  })

  // Log stderr for debugging
  proc.stderr?.on('data', (data: Buffer) => {
    console.error('[python]', data.toString().trim())
  })

  proc.on('exit', (code: number | null, signal: string | null) => {
    console.log(`[python] Process exited (code: ${code}, signal: ${signal})`)
    pythonProcess = null
    rl = null
    // If someone was waiting for a response, resolve with error
    if (pendingResolve) {
      const resolve = pendingResolve
      pendingResolve = null
      const reason = signal
        ? `Python process was terminated (${signal})`
        : code !== 0
          ? `Python process exited with error (code ${code})`
          : 'Python process exited'
      resolve({ type: 'error', message: reason })
    }
  })

  return proc
}

/**
 * Send a command to the Python subprocess and wait for a terminal response.
 *
 * Safety timeout (2 hours) is reset every time a progress message arrives,
 * so an active-but-slow import never times out. The timeout only fires if
 * the subprocess goes completely silent for 2 hours.
 */
const COMMAND_TIMEOUT_MS = 2 * 60 * 60 * 1000 // 2 hours

async function sendCommand(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!pythonProcess?.stdin) {
    throw new Error('Python process not started')
  }

  return new Promise((resolve, reject) => {
    pendingResolve = resolve

    const json = JSON.stringify(cmd) + '\n'
    pythonProcess!.stdin!.write(json, (err) => {
      if (err) {
        pendingResolve = null
        pendingTimeoutReset = null
        reject(err)
      }
    })

    // Resettable safety timeout — reset on every progress message
    let timeout = setTimeout(onTimeout, COMMAND_TIMEOUT_MS)

    function onTimeout() {
      if (pendingResolve === wrappedResolve) {
        pendingResolve = null
        pendingTimeoutReset = null
        reject(new Error('Python command timed out (no activity for 2 hours)'))
      }
    }

    // Allow progress message handler to reset the timeout
    pendingTimeoutReset = () => {
      clearTimeout(timeout)
      timeout = setTimeout(onTimeout, COMMAND_TIMEOUT_MS)
    }

    // Clear timeout when terminal message resolves the promise
    const wrappedResolve = (msg: Record<string, unknown>) => {
      clearTimeout(timeout)
      pendingTimeoutReset = null
      resolve(msg)
    }
    pendingResolve = wrappedResolve
  })
}

/**
 * Kill the Python subprocess immediately.
 * Used when user cancels an import — the subprocess is terminated.
 */
function killPythonProcess(): void {
  if (pythonProcess) {
    console.log('[python] Killing subprocess (cancel requested)')
    if (process.platform === 'win32') {
      // Windows: SIGTERM/SIGKILL are ignored. kill() without signal calls TerminateProcess.
      pythonProcess.kill()
      pythonProcess = null
    } else {
      // Unix: graceful SIGTERM, then force SIGKILL after 2s
      pythonProcess.kill('SIGTERM')
      setTimeout(() => {
        if (pythonProcess) {
          pythonProcess.kill('SIGKILL')
          pythonProcess = null
        }
      }, 2000)
    }
  }
}

/**
 * Ensure the Python subprocess is started. Auto-detects Python if needed.
 */
async function ensurePythonStarted(): Promise<void> {
  if (pythonProcess) return

  const pythonPath = await detectPython()
  if (!pythonPath) {
    throw new Error('Python not found')
  }

  pythonProcess = startPythonProcess(pythonPath)

  // Verify it's alive
  const response = await sendCommand({ action: 'ping' })
  if ((response as Record<string, unknown>).type !== 'pong') {
    pythonProcess?.kill()
    pythonProcess = null
    throw new Error('Python process failed to start')
  }
}

// ---- IPC Handlers ----

ipcMain.handle('python:detect', async () => {
  try {
    console.log('[python:detect] Starting Python detection...')
    console.log('[python:detect] process.platform:', process.platform)
    const pythonPath = await detectPython()
    console.log('[python:detect] Result:', pythonPath || 'NOT FOUND')
    return { available: !!pythonPath, pythonPath }
  } catch (e) {
    console.error('[python:detect] Detection failed:', e)
    return { available: false, error: e instanceof Error ? e.message : 'Detection failed' }
  }
})

ipcMain.handle('python:start', async (_event, payload?: { pythonPath?: string }) => {
  if (pythonProcess) {
    return { ok: true, message: 'Already running' }
  }

  const pythonPath = payload?.pythonPath || await detectPython()
  if (!pythonPath) {
    return { ok: false, error: 'Python not found' }
  }

  try {
    pythonProcess = startPythonProcess(pythonPath)

    // Verify it's alive with a ping
    const response = await sendCommand({ action: 'ping' })
    if (response.type !== 'pong') {
      throw new Error('Unexpected response from Python process')
    }

    return { ok: true }
  } catch (e) {
    pythonProcess?.kill()
    pythonProcess = null
    const message = e instanceof Error ? e.message : 'Failed to start Python'
    return { ok: false, error: message }
  }
})

ipcMain.handle('python:stop', async () => {
  killPythonProcess()
  return { ok: true }
})

ipcMain.handle('python:cancel', async () => {
  killPythonProcess()
  return { ok: true }
})

ipcMain.handle('python:authenticate', async (_event, params: {
  url: string; db: string; login: string; password: string
}) => {
  try {
    const result = await sendCommand({ action: 'authenticate', ...params })
    return result
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Authentication failed'
    return { type: 'error', message }
  }
})

ipcMain.handle('python:import', async (_event, payload: {
  url: string; db?: string
  model: string; file_path?: string; file_paths?: string[]
  field_mappings: Record<string, string>
  raw_rows?: Record<string, string>[]
  use_external_id?: boolean; search_keys?: string[]
  dry_run?: boolean; strict?: boolean
  batch_size?: number; delimiter?: string; encoding?: string
  has_header?: boolean
}) => {
  try {
    await ensurePythonStarted()

    // Resolve credentials from the session manager (auto-reauths if expired)
    const creds = await getCredentials(payload.url, payload.db)
    if (!creds) {
      return { type: 'error', message: 'No stored credentials for this session. Please re-login.' }
    }

    // Resolve file UUID to real filesystem path if needed
    let filePath = payload.file_path
    if (filePath && !filePath.startsWith('/') && !filePath.match(/^[A-Z]:\\/)) {
      // Looks like a UUID, resolve from file registry
      const resolved = getFilePath(filePath)
      if (resolved) {
        filePath = resolved
      }
    }

    const cmd = {
      action: 'import',
      ...payload,
      file_path: filePath,
      db: payload.db || getSession(payload.url)?.db,
      uid: creds.uid,
      password: creds.password,
    }

    console.log('[python:import] Starting import for:', filePath)
    const result = await sendCommand(cmd)
    console.log('[python:import] Result type:', (result as Record<string, unknown>).type)
    return result
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Import failed'
    return { type: 'error', message }
  }
})

ipcMain.handle('python:models', async (_event, payload: {
  url: string; db: string; uid: number; password: string
}) => {
  try {
    return await sendCommand({ action: 'models', ...payload })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to list models'
    return { type: 'error', message }
  }
})

ipcMain.handle('python:fields', async (_event, payload: {
  url: string; db: string; uid: number; password: string
  model: string
}) => {
  try {
    return await sendCommand({ action: 'fields', ...payload })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to get fields'
    return { type: 'error', message }
  }
})

ipcMain.handle('python:analyze', async (_event, payload: {
  fileId: string
  encoding?: string
  delimiter?: string
}) => {
  console.log('[python:analyze] Called with fileId:', payload.fileId)
  // Resolve file UUID to real path from the file registry
  const filePath = getFilePath(payload.fileId)
  console.log('[python:analyze] Resolved path:', filePath || 'NOT FOUND')
  if (!filePath) {
    return { ok: false, error: `Unknown file ID: ${payload.fileId}` }
  }

  try {
    await ensurePythonStarted()
    console.log('[python:analyze] Sending analyze command for:', filePath)
    const result = await sendCommand({
      action: 'analyze',
      file_path: filePath,
      encoding: payload.encoding || 'utf-8',
      delimiter: payload.delimiter || '',
    })
    console.log('[python:analyze] Result:', JSON.stringify(result).substring(0, 200))
    return { ok: true, result }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Analysis failed'
    console.error('[python:analyze] Error:', message)
    return { ok: false, error: message }
  }
})

ipcMain.handle('python:progress', async () => {
  // Drain queued progress messages
  const messages = [...messageQueue]
  messageQueue = []
  return messages
})

/**
 * Cleanup on app quit.
 */
export function shutdownPython(): void {
  if (pythonProcess) {
    pythonProcess.kill()
    pythonProcess = null
  }
}
