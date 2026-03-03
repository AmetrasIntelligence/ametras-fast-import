# Ametras Fast Import for Odoo

A high-performance CSV import tool for Odoo, available as both an **Odoo addon** (embedded client action) and a standalone **Electron desktop client**.

## Features

- **Streaming CSV Processing** - Handles files >1GB with constant memory usage
- **Parallel Batch Processing** - 1-4 configurable workers for high throughput
- **Automatic Retries** - Failed rows automatically retried with configurable limits
- **External ID Support** - Upsert via `ir.model.data` for migration-safe imports
- **Reference Resolution** - Bulk prefetch of external IDs for O(1) lookups
- **Per-Row Savepoints** - One failed row doesn't kill the entire batch
- **Pause/Resume** - Import can be paused and resumed at any time
- **Network Resilience** - Auto-pause on network errors, exponential backoff health checks, automatic resume on reconnection
- **Import Log Lifecycle** - Server-side log records with heartbeat, tracking `running -> completed/failed/interrupted` states
- **Resume Interrupted Imports** - Resume from where you left off after browser close, network outage, or crash
- **Cron Jobs** - Automatic stale log detection and old file cleanup
- **Error Export** - Failed rows can be exported as CSV for manual review
- **Multi-File Imports** - Process multiple files in sequence with dependencies
- **Import Profiles** - Named configurations stored server-side in Odoo, with ZIP upload/download and RunConfig overrides
- **Smart Mapping** - Filename-to-model and header-to-field suggestions with confidence scoring
- **Drag & Drop** - File import via drag & drop with `.csv` filter
- **Saved Mappings** - Per-server filename-to-model associations with glob support

## Documentation

Detailed documentation is available in the `docs/` directory:

*   **[Introduction](docs/index.md)** - Overview and Key Features
*   **[Getting Started](docs/getting-started/installation.md)** - Installation and Quickstart
*   **[User Guide](docs/user-guide/connection.md)** - Comprehensive usage instructions
*   **[Technical Reference](docs/reference/strategies.md)** - Strategies, transforms, and settings
*   **[Developer Guide](docs/developer-guide/architecture.md)** - Architecture, testing, and extending

## Architecture

The project is split into two packages that share Vue source code via path aliases:

```
                    ametras_fast_import_addon/vue-app/src/
                    (shared Vue components, stores, engine)
                         /                    \
                        /                      \
   ametras_fast_import_addon/          ametras_fast_import_client/
   (Odoo client action,               (Electron desktop app,
    IIFE lib build)                    hash routing, login)
```

### Odoo Embedded Mode

```
+---------------------------------------------------------+
|  Odoo 16+ Backend                                       |
|  csv_import_action.js (OWL) -> mountApp() / unmountApp()|
|  /ametras_fast_import/run (savepoint per row, upsert)   |
|  /ametras_fast_import/log/* (create, update, finalize)  |
|  /ametras_fast_import/profile/* (CRUD, ZIP)             |
|  Cron: stale log detection (hourly), file cleanup       |
+---------------------------------------------------------+
        |
        v  IIFE (static/vue/app.js)
+---------------------------------------------------------+
|  Vue App (Persistent Pinia, memory history)             |
|  Import Engine, Worker Pool, Connection Monitor         |
|  Stores: session / config / run / files / profiles      |
+---------------------------------------------------------+
```

### Electron Desktop Mode

```
+---------------------------------------------------------+
|  Electron Main Process                                  |
|  File Dialog + Streaming, OdooSession, Credential Store |
+----------------------------+----------------------------+
                             | IPC Bridge
+----------------------------v----------------------------+
|  Vue Renderer (Context Isolated)                        |
|  UI Components, Import Engine, Pinia Stores             |
+---------------------------------------------------------+
        |
        v  JSON-RPC
+---------------------------------------------------------+
|  Odoo 16+ Backend                                       |
+---------------------------------------------------------+
```

## Tech Stack

- **Frontend**: Vue 3 + TypeScript + Pinia
- **Styling**: Bootstrap 5 (bundled in Electron, provided by Odoo in embedded mode)
- **Desktop**: Electron with context isolation
- **Build**: Vite (IIFE lib for addon, standard for client) + electron-builder
- **Linting**: ESLint 10 (flat config) + typescript-eslint + eslint-plugin-vue
- **Testing**: Vitest (unit/integration) + Playwright (e2e)
- **Backend**: Odoo 16+ addon (Python)
- **i18n**: vue-i18n (runtime-only), locales: German (`de`), English (`en`)

## Prerequisites

- Node.js 18+
- npm 9+
- Odoo 16+ instance with the `ametras_fast_import_addon` installed

## Installation

### Odoo Addon

```bash
# Copy the addon to your Odoo addons path
cp -r ametras_fast_import_addon /path/to/odoo/addons/
# Then install via Odoo Apps menu
```

### Vue App (Odoo Embedded)

```bash
cd ametras_fast_import_addon/vue-app
npm install
npm run build    # outputs to ../static/vue/app.js + style.css
```

### Electron Client

```bash
cd ametras_fast_import_client
npm install
npm run electron:build   # packages for macOS/Windows/Linux
```

## Development

### Vue App (shared source)

```bash
cd ametras_fast_import_addon/vue-app

npm run dev              # Vite dev server with Odoo proxy
npm run typecheck        # Type checking
npm run lint             # ESLint check
npm run lint:fix         # ESLint auto-fix
npm run test:unit        # 561 unit tests
npm run test:watch       # Re-run on file changes
npm run test:coverage    # Coverage report
npm run build            # Production build -> ../static/vue/
```

### Electron Client

```bash
cd ametras_fast_import_client

npm run dev              # Vite dev server
npm run dev:electron     # Electron dev mode
npm run typecheck        # Type checking
npm run lint             # ESLint check
npm run lint:fix         # ESLint auto-fix
npm run build            # Production build
npm run electron:build   # Package desktop app
npm run test:e2e         # Playwright e2e tests
npm run test:e2e:ui      # Interactive e2e UI
```

## Project Structure

```
ametras-fast-import/
├── ametras_fast_import_addon/            # Odoo addon (works independently)
│   ├── __init__.py, __manifest__.py
│   ├── controllers/
│   │   ├── import_controller.py          # Import run endpoints
│   │   ├── log_controller.py             # Log lifecycle endpoints
│   │   ├── file_controller.py            # File upload/management
│   │   └── profile_controller.py         # Profile CRUD + ZIP
│   ├── models/
│   │   ├── csv_import_profile.py         # Profile storage model
│   │   └── csv_import_log.py             # Import log model
│   ├── views/, data/, security/          # Odoo metadata
│   ├── static/
│   │   ├── src/js/csv_import_action.js   # OWL bridge
│   │   ├── src/xml/csv_import_action.xml
│   │   └── vue/app.js + style.css        # Built Vue output
│   ├── tests/                            # Python tests
│   └── vue-app/                          # Vue source
│       ├── package.json, vite.config.ts
│       ├── tsconfig.json, vitest.config.ts
│       ├── eslint.config.js              # ESLint 10 flat config
│       ├── src/
│       │   ├── main.ts                   # mountApp()/unmountApp()
│       │   ├── App.vue
│       │   ├── api/                      # Odoo API client
│       │   ├── importer/                 # Engine, parser, workers
│       │   │   ├── engine.ts             # Main orchestrator
│       │   │   ├── csvParser.ts          # Streaming CSV parser
│       │   │   ├── workerPool.ts         # Parallel batch workers
│       │   │   ├── connectionMonitor.ts  # Network health check
│       │   │   ├── batchExecutor.ts      # Batch processing
│       │   │   ├── retryQueue.ts         # Failed row handling
│       │   │   ├── stateMachine.ts       # Import state FSM
│       │   │   └── standalone/           # Standalone mode executor
│       │   ├── stores/                   # Pinia state management
│       │   ├── components/               # Vue components
│       │   ├── composables/              # Vue composables
│       │   ├── services/                 # Import mode, profiles
│       │   ├── types/                    # TypeScript types
│       │   ├── utils/                    # Helpers and utilities
│       │   ├── ui/                       # Bootstrap wrappers
│       │   ├── views/                    # Route views
│       │   ├── i18n/                     # vue-i18n (de, en)
│       │   └── constants/                # Default settings
│       └── tests/
│           ├── setup.ts                  # Test configuration
│           ├── fixtures/                 # Demo CSV data
│           ├── unit/                     # 561 Vitest unit tests
│           └── integration/              # Integration tests
├── ametras_fast_import_client/           # Electron client
│   ├── package.json, vite.config.ts
│   ├── tsconfig.json, playwright.config.ts
│   ├── eslint.config.js                 # ESLint 10 flat config
│   ├── index.html
│   ├── electron/
│   │   ├── main.ts                       # Electron main process
│   │   ├── preload.ts                    # IPC bridge
│   │   └── ipc/                          # IPC handlers
│   │       ├── files.ts                  # File streaming
│   │       ├── odoo.ts                   # Odoo RPC proxy
│   │       ├── store.ts                  # Persistent storage
│   │       ├── profile.ts               # Profile ZIP handling
│   │       └── standalone/               # Standalone mode IPC
│   ├── src/
│   │   ├── main.ts                       # Electron entry (login, routing)
│   │   └── views/LoginView.vue
│   └── tests/e2e/                        # Playwright e2e tests
└── docs/                                 # Project documentation
```

### Code Sharing

The client's `@/` path alias resolves to `../ametras_fast_import_addon/vue-app/src/`, so both packages share the same Vue components, stores, engine, and utilities. The client adds only Electron-specific code (login, IPC, file system access).

## Import State Machine

```
IDLE -> VALIDATING -> RUNNING_FILE <-> RUNNING_BATCH -> COMPLETED
                         |              |
                      PAUSED      -> RETRYING
                         |
                       IDLE (abort)
```

## Configuration Options

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `batchSize` | 200 | 1-1000 | Rows per batch sent to Odoo (standalone: 10-100) |
| `workers` | 1 | 1-4 | Parallel workers for batch processing |
| `retryLimit` | 3 | 0-10 | Max retry attempts per row |
| `retryDelayMs` | 500 | 100+ | Delay between retry attempts |
| `encoding` | utf-8-sig | - | CSV file encoding (utf-8-sig, utf-8, latin-1, cp1252) |
| `delimiter` | , | - | CSV delimiter (auto-detect supported) |
| `dryRun` | false | - | Validate without committing |

## External ID Handling

The tool supports two ID column types for the record being imported:

- **`id` column**: Uses Odoo's `ir.model.data` for upsert. Records are identified by external ID (xml_id), making imports migration-safe and repeatable.
- **`.id` column**: Direct database ID. Only use for same-database operations.

### Relational Field References

For Many2One and Many2Many fields, use suffixed column headers:

| Pattern | Example | Resolution |
|---------|---------|------------|
| `field/id` | `partner_id/id` | External ID |
| `field/.id` | `country_id/.id` | Database ID (standard models only) |

**Standard models for `/.id`:** `res.country`, `res.currency`, `uom.uom`, `res.lang`

**Many2Many:** Use pipe-delimited IDs: `tag_ids/id` -> `tag_a|tag_b|tag_c`

See [docs/reference/transforms.md](docs/reference/transforms.md) for full documentation.

## Test Suite

The project includes 561 unit/integration tests and Playwright e2e tests.

See **[Testing Strategy](docs/developer-guide/testing.md)** for details.

## Design Decisions

1. **Two-package split** - Shared Vue source in the addon's `vue-app/`, client adds only Electron-specific code
2. **Path alias sharing** - Client's `@/` resolves to addon's `vue-app/src/` via vite/tsconfig aliases
3. **IIFE lib build** - Vue app built as self-executing library for Odoo embedding
4. **Vue owns import logic** - Odoo only validates and writes, keeping the backend simple
5. **Bootstrap 5** - Uses Bootstrap classes and CSS variables so the app inherits Odoo's theme when embedded
6. **Context isolation** - Secure IPC bridge, no Node.js in renderer
7. **Savepoint per row** - Transactional safety without batch-level rollbacks
8. **Streaming** - Memory efficiency for large files
9. **State machine** - Deterministic, pausable, resumable imports
10. **Parallel batches, sequential files** - Worker pool for throughput, file order for dependencies
11. **Reference prefetch** - Bulk resolve external IDs for O(1) lookups during import
12. **Server-side profile storage** - Profiles in Odoo, client is cache only
13. **Persistent Pinia** - Store survives mount/unmount in Odoo embedded mode
14. **Log lifecycle** - Server-side log records track import progress with 30s heartbeat
15. **i18n** - vue-i18n runtime-only with German (default/fallback) and English; locale auto-detected from Odoo's `lang` attribute in embedded mode

## License

Proprietary - Ametras GmbH
