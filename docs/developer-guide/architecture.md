# Architecture Overview

The Ametras Fast Import tool is split into two packages:

- **`ametras_fast_import_addon/vue-app/`** - Shared Vue 3 + TypeScript source, built as an IIFE library for Odoo embedding
- **`ametras_fast_import_client/`** - Electron desktop client that shares the Vue source via path aliases

## Process Model

### Odoo Embedded Mode

When installed as an Odoo addon, the Vue app is mounted as a client action:

1. `csv_import_action.js` (OWL component) calls `window.AmetrasCsvImport.mountApp(el, options)`
2. The Vue app uses memory history (no hash routing) and persistent Pinia stores
3. API calls go directly to Odoo's JSON-RPC endpoints (same origin)

### Electron Main Process
*   **Responsibilities**: Window management, native file system access, secure persistent storage, and the IPC bridge.
*   **Key Modules**:
    *   `ametras_fast_import_client/electron/main.ts`: Application bootstrap and lifecycle.
    *   `ametras_fast_import_client/electron/ipc/files.ts`: Handles streaming file reads from disk.
    *   `ametras_fast_import_client/electron/ipc/odoo.ts`: Proxy for JSON-RPC calls to bypass CORS and manage sessions.

### Vue Renderer Process (The Frontend)
*   **Responsibilities**: User Interface, import logic, state management, and orchestration.
*   **Context Isolation**: The renderer is isolated from Node.js APIs for security. It communicates with the Main process via a controlled IPC bridge (`window.api`).
*   **Tech Stack**:
    *   **Framework**: Vue 3 (Composition API).
    *   **State Management**: Pinia (stores for session, files, config, and run state).
    *   **Styling**: Bootstrap 5 utility classes and CSS variables. In Electron mode, Bootstrap CSS is bundled; in Odoo embedded mode, Bootstrap is provided by Odoo. Component-specific styles use scoped CSS with `csv-` BEM prefixes.

## Code Sharing

Both packages share the same Vue source code via path aliases:

```
ametras_fast_import_addon/vue-app/src/   <-- Shared source (components, stores, engine)
     ^                          ^
     |                          |
  vue-app vite.config.ts     client vite.config.ts
  alias: @ -> src/           alias: @ -> ../ametras_fast_import_addon/vue-app/src/
```

The client adds only:
- `src/main.ts` - Electron entry with login flow and hash routing
- `src/views/LoginView.vue` - Login screen
- `electron/` - Electron main process and IPC handlers

## Data Flow

```
+--------------------------------+       +-------------------------+
|       Electron Main            |       |      Odoo Backend       |
|  (Native FS, Network Proxy)   |<----->| (ametras_fast_import)   |
+---------------^----------------+       +-------------------------+
                |
                | IPC (JSON)
                |
+---------------v----------------+
|       Vue Renderer             |
|  (Import Engine, UI, Stores)   |
+--------------------------------+
```

## Key Components

### The Import Engine (`vue-app/src/importer/engine.ts`)
The orchestrator that manages the transition between states (Idle, Validating, Running, Paused, Completed). It uses a Finite State Machine (FSM) to ensure deterministic behavior. Integrates with the Connection Monitor for network resilience and the Log Lifecycle API for server-side persistence.

### Streaming CSV Parser (`vue-app/src/importer/csvParser.ts`)
Wraps PapaParse to provide a streaming interface. It reads chunks from the Main process, ensuring that even multi-gigabyte files don't exceed the memory limits of the renderer process.

### Worker Pool (`vue-app/src/importer/workerPool.ts`)
Manages the parallel execution of batches. It ensures that the order of rows is preserved within a file while allowing multiple batches to be in flight to Odoo simultaneously.

### Connection Monitor (`vue-app/src/importer/connectionMonitor.ts`)
Monitors server connectivity and polls with exponential backoff when the connection is lost. Accepts an injectable `HealthCheckFn` so that both embedded mode (`/ametras_fast_import/info`) and standalone mode (`/web/session/get_session_info`) can use the same monitor. Backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s (cap).

### Batch Executor (`vue-app/src/importer/batchExecutor.ts`)
Executes batches via the addon's `/ametras_fast_import/run` endpoint. Throws `NetworkBatchError` on transient network failures (HTTP 502/503/504, timeouts) so the engine can pause and retry instead of marking rows as permanently failed.

### Import Settings (`vue-app/src/components/ImportSettings.vue`)
A settings form rendered inside the **Settings** tab of the Import view. Exposes batch size, workers, retry, encoding, and delimiter controls. Standalone mode automatically constrains certain values (e.g. batch size capped to 100).

## Network Resilience

The import system distinguishes network/transient errors from data errors to prevent network failures from permanently marking rows as failed.

### Error Classification (`vue-app/src/utils/errors.ts`)
- `classifyFetchError(error)`: Inspects raw Error objects to determine the cause.
- `isNetworkError(error)` / `isNetworkErrorCode(code)`: Check if an error is in the `'network'` category.
- `ERROR_CATEGORY`: Maps every `ImportErrorCode` to one of `'network' | 'data' | 'config' | 'auth'`.

### Auto-Recovery Flow
1. Batch executor detects network error -> throws `NetworkBatchError` (rows NOT marked failed)
2. Engine catches `NetworkBatchError` -> calls `connectionMonitor.reportOffline()`
3. Engine transitions to PAUSED state, sets `run.connectionStatus = 'offline'`
4. Connection Monitor polls server with exponential backoff
5. Server responds -> `connectionMonitor.reportOnline()` resolves waiters
6. Engine resumes, retries the failed batch

## Log Lifecycle

Server-side import logs persist throughout the import, not just at the end.

### API Endpoints (`vue-app/src/api/odooClient.ts`)
| Function | Endpoint | Purpose |
|----------|----------|---------|
| `createImportLog()` | `/ametras_fast_import/log/create` | Create log at import start (state='running') |
| `updateImportLog()` | `/ametras_fast_import/log/update` | Heartbeat + progress update (every 30s) |
| `finalizeImportLog()` | `/ametras_fast_import/log/finalize` | Set final state, counts, error log |
| `getImportLog()` | `/ametras_fast_import/log/get` | Fetch full log for resume |

### Row Tracking with `processedRanges`
The engine tracks which row indices have been processed using `indicesToRanges()`, which compacts a `Set<number>` into sorted `[start, end]` inclusive ranges. This enables precise resume -- on resume, the engine re-processes only rows NOT in `processedRanges` plus rows in the `error_log`.

## Embedded Mode (Odoo Client Action)

The Vue app is mounted via `vue-app/src/main.ts`:
- **Persistent Pinia**: The pinia store instance survives mount/unmount cycles so the import engine and its state persist when the user navigates away from the client action.
- **Smart Routing**: On remount, the app auto-routes to `/run` if an import is active or `/results` if one just completed.
- **Locale Sync**: The app syncs its locale from Odoo's `lang` attribute on `<html>`.

## Internationalization (i18n)

The app uses `vue-i18n` in runtime-only mode with two supported locales:

| Locale | Key | Role |
|--------|-----|------|
| German | `de` | Default and fallback locale |
| English | `en` | Secondary locale |

### Language Detection

In **embedded (Odoo) mode**, the locale is detected from `document.documentElement.lang`:
- Odoo sets `<html lang="de_DE">` (or similar) based on the user's language preference
- The app normalizes this to a two-letter code (e.g. `de_DE` → `de`)
- If the detected locale is not in the supported set, it falls back to `de`

In **Electron mode**, the locale defaults to `de`.

### Translation Files

Translation files are at `vue-app/src/i18n/locales/en.json` and `de.json`. Both files must maintain 1:1 key parity. All user-visible strings should use `$t()` (templates) or `t()` (script) — no hardcoded text.

## Conventions

### Logging

Use the structured `logger` utility (`vue-app/src/utils/logger.ts`) instead of `console.*` calls:

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
