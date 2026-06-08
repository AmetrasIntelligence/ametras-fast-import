import { app, BrowserWindow, session } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Import IPC handlers
import './ipc/files'
import './ipc/odoo'
import './ipc/store'
import './ipc/profile'
import './ipc/standalone'
import './ipc/python'

// Import cleanup functions
import { clearFileRegistry } from './ipc/files'
import { shutdownSessions } from './ipc/odoo'
import { shutdownPython } from './ipc/python'

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  // Allow servers with self-signed or invalid SSL certificates (e.g. test servers on bare IPs).
  // net.fetch() in IPC handlers respects this proc; Node.js global fetch() does not.
  session.defaultSession.setCertificateVerifyProc((_request, callback) => {
    callback(0)
  })
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Cleanup on app quit
app.on('will-quit', () => {
  shutdownSessions()
  shutdownPython()
  clearFileRegistry()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
