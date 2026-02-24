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
    *   **Styling**: Plain CSS with a `csv-` prefix to avoid conflicts if embedded.

## Data Flow

```
┌────────────────────────────────┐       ┌─────────────────────────┐
│       Electron Main            │       │      Odoo Backend       │
│  (Native FS, Network Proxy)    │◄─────►│ (Addon: csv_import)     │
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
The orchestrator that manages the transition between states (Idle, Validating, Running, Paused, Completed). It uses a Finite State Machine (FSM) to ensure deterministic behavior.

### Streaming CSV Parser (`src/importer/csvParser.ts`)
Wraps PapaParse to provide a streaming interface. It reads chunks from the Main process, ensuring that even multi-gigabyte files don't exceed the memory limits of the renderer process.

### Worker Pool (`src/importer/workerPool.ts`)
Manages the parallel execution of batches. It ensures that the order of rows is preserved within a file while allowing multiple batches to be in flight to Odoo simultaneously.

### Import Settings (`src/components/ImportSettings.vue`)
A settings form rendered inside the **Settings** tab of the Import view. Exposes batch size, workers, retry, encoding, and delimiter controls. Standalone mode automatically constrains certain values (e.g. batch size capped to 100).

### Persistence Layer (`src/importer/persistence.ts`)
Periodically saves the current import state to the Electron store. If the app crashes or is closed, the user can resume the import from the last successful batch.

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
