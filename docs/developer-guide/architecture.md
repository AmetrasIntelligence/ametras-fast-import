# Architecture Overview

The CSV Import Tool is built as an Electron desktop application using Vue 3 and TypeScript. It follows a multi-process architecture to ensure UI responsiveness and security.

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

### Worker Pool (`src/importer/batchExecutor.ts`)
Manages the parallel execution of batches. It ensures that the order of rows is preserved within a file while allowing multiple batches to be in flight to Odoo simultaneously.

### Persistence Layer (`src/importer/persistence.ts`)
Periodically saves the current import state to the Electron store. If the app crashes or is closed, the user can resume the import from the last successful batch.
