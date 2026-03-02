# Architecture Overview

The CSV Import Tool is built as an Electron desktop application using Vue 3 and TypeScript. It follows a multi-process architecture to ensure UI responsiveness and security. It also supports a browser-only mode (no Electron) with stubs provided by `src/utils/browserFallback.ts`.

## Process Model

### Electron Main Process
*   **Responsibilities**: Window management, native file system access, secure persistent storage (electron-store), and the IPC bridge.
*   **Key Modules**:
    *   `electron/main.ts`: Application bootstrap and lifecycle.
    *   `electron/ipc/files.ts`: Handles streaming file reads from the disk.
    *   `electron/ipc/odoo.ts`: Proxy for JSON-RPC calls to bypass CORS and manage sessions.

### Vue Renderer Process (The Frontend)
*   **Responsibilities**: User Interface, import logic, state management, and orchestration.
*   **Context Isolation**: The renderer is isolated from Node.js APIs for security. It communicates with the Main process via a controlled IPC bridge (`window.api`).
*   **Browser Fallback**: When running without Electron (e.g. `npm run dev`), `main.ts` calls `installBrowserFallback()` which provides stub implementations for `window.api` using `fetch` and `localStorage`.
*   **Tech Stack**:
    *   **Framework**: Vue 3 (Composition API).
    *   **State Management**: Pinia (stores for session, files, config, and run state).
    *   **Styling**: Bootstrap 5 utility classes and CSS variables. In Electron mode, Bootstrap CSS is bundled; in Odoo embedded mode, Bootstrap is provided by Odoo. Component-specific styles use scoped CSS with `csv-` BEM prefixes.

## Data Flow

```
┌────────────────────────────────┐       ┌─────────────────────────┐
│       Electron Main            │       │      Odoo Backend       │
│  (Native FS, Network Proxy)    │◄─────►│ (Addon: ametras_fast_import)     │
└───────────────▲────────────────┘       └─────────────────────────┘
                │
                │ IPC (JSON)
                │
┌───────────────▼────────────────┐
│       Vue Renderer             │
│  (Import Engine, UI, Stores)   │
└────────────────────────────────┘
```

## Key Components

### The Import Engine (`src/importer/engine.ts`)
The orchestrator that manages the transition between states (Idle, Validating, Running, Paused, Completed). It uses a Finite State Machine (FSM) to ensure deterministic behavior. Integrates with the Connection Monitor for network resilience and the Log Lifecycle API for server-side persistence.

### Streaming CSV Parser (`src/importer/csvParser.ts`)
Wraps PapaParse to provide a streaming interface. It reads chunks from the Main process, ensuring that even multi-gigabyte files don't exceed the memory limits of the renderer process.

### Worker Pool (`src/importer/workerPool.ts`)
Manages the parallel execution of batches. It ensures that the order of rows is preserved within a file while allowing multiple batches to be in flight to Odoo simultaneously.

### Connection Monitor (`src/importer/connectionMonitor.ts`)
Monitors server connectivity and polls with exponential backoff when the connection is lost. Accepts an injectable `HealthCheckFn` so that both embedded mode (`/ametras_fast_import/info`) and standalone mode (`/web/session/get_session_info`) can use the same monitor. Backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s (cap).

### Batch Executor (`src/importer/batchExecutor.ts`)
Executes batches via the addon's `/ametras_fast_import/run` endpoint. Throws `NetworkBatchError` on transient network failures (HTTP 502/503/504, timeouts) so the engine can pause and retry instead of marking rows as permanently failed.

### Import Settings (`src/components/ImportSettings.vue`)
A settings form rendered inside the **Settings** tab of the Import view. Exposes batch size, workers, retry, encoding, and delimiter controls. Standalone mode automatically constrains certain values (e.g. batch size capped to 100).

### Persistence Layer (`src/importer/persistence.ts`)
Periodically saves the current import state to the Electron store. If the app crashes or is closed, the user can resume the import from the last successful batch.

## Network Resilience

The import system distinguishes network/transient errors from data errors to prevent network failures from permanently marking rows as failed.

### Error Classification (`src/utils/errors.ts`)
- `classifyFetchError(error)`: Inspects raw Error objects to determine the cause — `TypeError` → `NETWORK_ERROR`, `DOMException` AbortError → `TIMEOUT`, message patterns like 502/503/504 → `NETWORK_ERROR`.
- `isNetworkError(error)` / `isNetworkErrorCode(code)`: Check if an error is in the `'network'` category.
- `ERROR_CATEGORY`: Maps every `ImportErrorCode` to one of `'network' | 'data' | 'config' | 'auth'`.

### Auto-Recovery Flow
1. Batch executor detects network error → throws `NetworkBatchError` (rows NOT marked failed)
2. Engine catches `NetworkBatchError` → calls `connectionMonitor.reportOffline()`
3. Engine transitions to PAUSED state, sets `run.connectionStatus = 'offline'`
4. Connection Monitor polls server with exponential backoff
5. Server responds → `connectionMonitor.reportOnline()` resolves waiters
6. Engine resumes, retries the failed batch

## Log Lifecycle

Server-side import logs persist throughout the import, not just at the end.

### API Endpoints (`src/api/odooClient.ts`)
| Function | Endpoint | Purpose |
|----------|----------|---------|
| `createImportLog()` | `/ametras_fast_import/log/create` | Create log at import start (state='running') |
| `updateImportLog()` | `/ametras_fast_import/log/update` | Heartbeat + progress update (every 30s) |
| `finalizeImportLog()` | `/ametras_fast_import/log/finalize` | Set final state, counts, error log |
| `getImportLog()` | `/ametras_fast_import/log/get` | Fetch full log for resume |
| `saveImportLog()` | `/ametras_fast_import/log/save` | Legacy endpoint (backward compat) |

### Row Tracking with `processedRanges`
The engine tracks which row indices have been processed using `indicesToRanges()`, which compacts a `Set<number>` into sorted `[start, end]` inclusive ranges. This enables precise resume — on resume, the engine re-processes only rows NOT in `processedRanges` plus rows in the `error_log`.

## Embedded Mode (Odoo Client Action)

When running inside Odoo, the Vue app is mounted via `src/mainOdoo.ts`:
- **Persistent Pinia**: The pinia store instance survives mount/unmount cycles so the import engine and its state persist when the user navigates away from the client action.
- **Smart Routing**: On remount, the app auto-routes to `/run` if an import is active or `/results` if one just completed.
- **Locale Sync**: The app syncs its locale from Odoo's `lang` attribute on `<html>`.

## Conventions

### Logging

Use the structured `logger` utility (`src/utils/logger.ts`) instead of `console.*` calls:

```typescript
import { logger } from '@/utils/logger'
logger.info('Import started', { fileCount: 3 })
logger.error('Batch failed', { batchId, error })
```

### Dialogs

Use `showAlert()` / `showConfirm()` / `showPrompt()` from `useDialog` instead of native `alert()` / `confirm()` / `prompt()`. Native browser dialogs are blocked by Electron's context isolation.

```typescript
import { useDialog } from '@/composables/useDialog'
const { showAlert, showConfirm } = useDialog()
await showAlert('Import complete!')
```
