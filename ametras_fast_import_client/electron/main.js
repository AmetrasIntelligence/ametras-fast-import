import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
// ESM-compatible __dirname
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
// Import IPC handlers
import './ipc/files';
import './ipc/odoo';
import './ipc/store';
import './ipc/profile';
import './ipc/standalone';
// Import cleanup functions
import { clearFileRegistry } from './ipc/files';
import { shutdownSessions } from './ipc/odoo';
var mainWindow = null;
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
    });
    if (process.env.VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
        mainWindow.webContents.openDevTools();
    }
    else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }
}
app.whenReady().then(createWindow);
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin')
        app.quit();
});
// Cleanup on app quit
app.on('will-quit', function () {
    shutdownSessions();
    clearFileRegistry();
});
app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0)
        createWindow();
});
