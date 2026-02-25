# CSV Import Tool for Odoo

A desktop application for importing large CSV files into Odoo with streaming processing, automatic retries, and comprehensive error handling.

## Features

- **Streaming CSV Processing** - Handles files >1GB with constant memory usage
- **Parallel Batch Processing** - 1-4 configurable workers for high throughput
- **Automatic Retries** - Failed rows automatically retried with configurable limits
- **External ID Support** - Upsert via `ir.model.data` for migration-safe imports
- **Reference Resolution** - Bulk prefetch of external IDs for O(1) lookups
- **Per-Row Savepoints** - One failed row doesn't kill the entire batch
- **Pause/Resume** - Import can be paused and resumed at any time
- **Error Export** - Failed rows can be exported as CSV for manual review
- **Multi-File Imports** - Process multiple files in sequence with dependencies
- **Import Profiles** - Named configurations stored server-side in Odoo, with ZIP upload/download and RunConfig overrides
- **Smart Mapping** - Filename-to-model and header-to-field suggestions with confidence scoring
- **Smart Reference Detection** - Auto-detect `/id` (external ID) and `/.id` (database ID) column patterns
- **Drag & Drop** - File import via drag & drop with `.csv` filter
- **Validation Indicators** - Color-coded status (green/orange/red) gating import start
- **Saved Mappings** - Per-server filename-to-model associations with glob support
- **Searchable Field Select** - Dropdown with search by display name or technical name, type badges, relational sub-options
- **In-App Dialogs** - Custom alert/confirm/prompt dialogs (Electron blocks native `window.prompt`/`confirm`)
- **File Preview** - Expandable file rows showing CSV headers and first 4 sample rows
- **Persistent Navigation** - Top nav bar with Files / Configure / Profiles links and server info

## Documentation

Detailed documentation is available in the `docs/` directory:

*   **[Introduction](docs/index.md)** - Overview and Key Features
*   **[Getting Started](docs/getting-started/installation.md)** - Installation and Quickstart
*   **[User Guide](docs/user-guide/connection.md)** - Comprehensive usage instructions
*   **[Technical Reference](docs/reference/strategies.md)** - Strategies, transforms, and settings
*   **[Developer Guide](docs/developer-guide/architecture.md)** - Architecture, testing, and extending

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Main Process                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ File Dialog │  │ OdooSession  │  │ Credential Store   │  │
│  │ + Streaming │  │ Manager      │  │ (electron-store)   │  │
│  └──────┬──────┘  └──────┬───────┘  └────────────────────┘  │
│         └────────────────┴──────────────┬───────────────────│
│                                         │ IPC Bridge        │
├─────────────────────────────────────────┴───────────────────┤
│  Vue Renderer (Context Isolated)                             │
│  ┌──────────┐  ┌───────────┐  ┌────────────────────────────┐│
│  │ UI       │  │ Import    │  │ Pinia Stores               ││
│  │ Components│  │ Engine    │  │ (session/config/run/files/ ││
│  └──────────┘  └───────────┘  │  profiles/savedMappings)   ││
│                               └────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
            │
            ▼ JSON-RPC
┌─────────────────────────────────────────────────────────────┐
│  Odoo 16+ Backend                                            │
│  /ametras_fast_import/run (savepoint per row, upsert)       │
│  /ametras_fast_import/profile/* (CRUD, ZIP upload/download) │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

- **Frontend**: Vue 3 + TypeScript + Pinia
- **Desktop**: Electron with context isolation
- **Build**: Vite + electron-builder
- **Testing**: Vitest (unit/integration) + Playwright (e2e)
- **Backend**: Odoo 16+ addon (Python)

## Prerequisites

- Node.js 18+
- npm 9+
- Odoo 16+ instance with the `ametras_fast_import_addon` addon installed

## Installation

```bash
# Install dependencies
npm install

# Install the Odoo addon
cp -r ametras_fast_import_addon /path/to/odoo/addons/
# Then install via Odoo Apps menu
```

## Development

```bash
# Start development server (Vue + Electron)
npm run dev

# Run unit and integration tests (514 tests)
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run e2e tests (requires dev server running)
npm run test:e2e

# Run e2e tests with interactive UI
npm run test:e2e:ui

# Run all tests (unit + e2e)
npm run test:all

# Type checking
npm run typecheck

# Linting
npm run lint

# Lint with auto-fix
npm run lint:fix
```

## Building

```bash
# Build for production
npm run build

# Preview production build locally
npm run preview

# Package as desktop app
npm run electron:build
```

## Project Structure

```
csv-client/
├── electron/                    # Electron main process
│   ├── main.ts                  # App bootstrap
│   ├── preload.ts               # IPC bridge (window.api)
│   └── ipc/
│       ├── files.ts             # File streaming handlers
│       ├── odoo.ts              # Odoo RPC proxy + getSession()
│       ├── store.ts             # Persistent storage
│       ├── profile.ts           # Profile ZIP select/upload/export IPC
│       └── standalone/          # Standalone mode IPC
│           ├── detector.ts      # Addon availability check
│           └── loader.ts        # model.load() proxy
├── src/
│   ├── api/
│   │   ├── odooClient.ts        # Odoo API functions
│   │   ├── profileApi.ts        # Profile CRUD API (server-side)
│   │   └── types.ts             # Response types
│   ├── importer/
│   │   ├── engine.ts            # Main orchestrator
│   │   ├── stateMachine.ts      # Import states + transitions
│   │   ├── csvParser.ts         # PapaParse wrapper + streaming
│   │   ├── batchExecutor.ts     # Batch processing
│   │   ├── workerPool.ts        # Parallel worker coordination
│   │   ├── retryQueue.ts        # Failed row handling
│   │   ├── persistence.ts       # State recovery
│   │   ├── profileValidator.ts  # Profile + ProfileDraft validation
│   │   ├── fieldMappingValidator.ts # Field mapping validation
│   │   └── standalone/          # Standalone (no addon) import
│   │       ├── executor.ts      # Batch execution via model.load()
│   │       └── types.ts         # Standalone-specific types
│   ├── stores/
│   │   ├── session.ts           # Auth state
│   │   ├── config.ts            # Import settings
│   │   ├── files.ts             # Selected files
│   │   ├── run.ts               # Import progress
│   │   ├── profiles.ts          # Server-fetched profiles with cache
│   │   └── savedMappings.ts     # Per-server saved mappings
│   ├── types/
│   │   ├── importProfile.ts     # Profile types + CSV parse/export
│   │   ├── fieldMapping.ts      # FieldMapping + FieldTransform types
│   │   └── runConfig.ts         # RunConfig override type
│   ├── composables/
│   │   ├── useDialog.ts         # In-app alert/confirm/prompt dialogs
│   │   ├── useDropdown.ts       # Shared dropdown positioning logic
│   │   ├── useProfileImport.ts  # Profile ZIP upload composable
│   │   └── useRunConfig.ts      # Override merge composable
│   ├── services/
│   │   ├── importMode.ts        # Addon detection (standalone vs addon)
│   │   └── standaloneProfiles.ts # Local profile storage
│   ├── utils/
│   │   ├── logger.ts            # Structured logging
│   │   ├── smartMapping.ts      # Filename → Model scoring
│   │   ├── smartFieldMapping.ts # Header → Field scoring
│   │   ├── profileTemplates.ts  # Built-in profile templates
│   │   ├── profileExporter.ts   # ZIP export with overrides
│   │   ├── profileVersioning.ts # Version parse + compatibility
│   │   ├── profileZip.ts        # ZIP generation helpers
│   │   ├── rowTransform.ts      # Shared row data transformation
│   │   ├── download.ts          # Browser file download utilities
│   │   ├── browserFallback.ts   # Browser-mode window.api stubs
│   │   ├── stateLock.ts         # Async mutex for state serialization
│   │   ├── formatters.ts        # Number/time formatting helpers
│   │   ├── stringSimilarity.ts  # String similarity scoring
│   │   └── errors.ts            # Error type utilities
│   ├── constants/
│   │   └── defaults.ts          # Default settings values
│   ├── i18n/
│   │   └── index.ts             # Vue I18n setup
│   ├── ui/                      # UI component wrappers
│   │   ├── Button.vue
│   │   ├── Input.vue
│   │   ├── Select.vue
│   │   ├── Checkbox.vue
│   │   ├── Card.vue
│   │   ├── Table.vue
│   │   ├── Progress.vue
│   │   └── Divider.vue
│   ├── components/
│   │   ├── AppDialog.vue        # In-app modal dialog (alert/confirm/prompt)
│   │   ├── ErrorBoundary.vue
│   │   ├── FieldSelect.vue      # Searchable field dropdown with type badges
│   │   ├── FieldSuggestion.vue  # Field suggestion with confidence
│   │   ├── FileDropZone.vue     # Drag & drop file import
│   │   ├── FileList.vue         # Sortable file table with preview
│   │   ├── ImportSettings.vue   # Import settings form (tabbed)
│   │   ├── LanguageSelector.vue # UI language selector
│   │   ├── MappingStatus.vue    # Color-coded status indicator
│   │   ├── ModelSelect.vue      # Searchable model dropdown
│   │   ├── ModelSuggestion.vue  # Model suggestion with confidence
│   │   ├── ProfileEditor.vue    # Tabbed profile editor with overrides
│   │   ├── ProfileSelect.vue    # Profile dropdown selector
│   │   ├── StandaloneBanner.vue # Standalone mode warning banner
│   │   └── TransformSelect.vue  # Field transform selector
│   ├── views/
│   │   ├── LoginView.vue
│   │   ├── ImportView.vue       # Main import view (files, config, mapping)
│   │   ├── RunView.vue
│   │   ├── ResultsView.vue
│   │   └── SavedProfilesView.vue
│   ├── App.vue
│   ├── main.ts
│   └── shims-vue.d.ts           # Vue SFC type declarations
├── ametras_fast_import_addon/    # Odoo addon
│   ├── __init__.py
│   ├── __manifest__.py
│   ├── models/
│   │   ├── __init__.py
│   │   └── csv_import_profile.py  # csv.import.profile model
│   ├── controllers/
│   │   ├── __init__.py
│   │   ├── import_controller.py   # Import run endpoints
│   │   └── profile_controller.py  # Profile CRUD + ZIP upload/download
│   └── security/
│       └── ir.model.access.csv
├── tests/
│   ├── setup.ts                 # Test configuration
│   ├── fixtures/                # Demo CSV data
│   ├── unit/                    # Vitest unit tests
│   ├── integration/             # Integration tests
│   └── e2e/                     # Playwright e2e tests
│       ├── helpers.ts           # Shared e2e test utilities
│       └── import.spec.ts       # Import flow e2e test
└── docs/                        # Project documentation
    ├── standalone-mode.md
    └── ...
```

## Import State Machine

```
IDLE → VALIDATING → RUNNING_FILE ↔ RUNNING_BATCH → COMPLETED
                         ↓              ↓
                      PAUSED      → RETRYING
                         ↓
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
| `field/id` | `partner_id/id` | External ID → `res_partner_id#123` |
| `field/.id` | `country_id/.id` | Database ID → `57` (standard models only) |

**Standard models for `/.id`:** `res.country`, `res.currency`, `uom.uom`, `res.lang`

**Many2Many:** Use pipe-delimited IDs: `tag_ids/id` → `tag_a|tag_b|tag_c`

See [docs/reference/transforms.md](docs/reference/transforms.md) for full documentation.

## Test Suite

The project includes a comprehensive test suite with 514 tests covering both the TypeScript frontend and Python backend.

See **[Testing Strategy](docs/developer-guide/testing.md)** for details on how to run and extend tests.

## Design Decisions

1. **Vue owns import logic** - Odoo only validates and writes, keeping the backend simple
2. **CSS prefixed** (`csv-`) - Avoids conflicts with Odoo's styles
3. **Context isolation** - Secure IPC bridge, no Node.js in renderer
4. **Savepoint per row** - Transactional safety without batch-level rollbacks
5. **Streaming** - Memory efficiency for large files
6. **State machine** - Deterministic, pausable, resumable imports
7. **Parallel batches, sequential files** - Worker pool for throughput, file order for dependencies
8. **Reference prefetch** - Bulk resolve external IDs for O(1) lookups during import
9. **Server-side profile storage** - Profiles in Odoo, client is cache only
10. **Immutable profiles + RunConfig overrides** - Never edit profiles directly
11. **In-app dialogs** - Custom modal dialogs since Electron blocks native browser dialogs
12. **No external UI dependencies** - Native HTML5 drag & drop, CSS-only indicators, plain HTML components
13. **Standard models for /.id** - Database IDs only for stable reference data (countries, currencies, UoM)

## License

Proprietary - Ametras GmbH
