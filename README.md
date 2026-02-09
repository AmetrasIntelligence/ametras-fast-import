# CSV Import Tool for Odoo

A desktop application for importing large CSV files into Odoo with streaming processing, automatic retries, and comprehensive error handling.

## Features

- **Streaming CSV Processing** - Handles files >1GB with constant memory usage
- **Batch Processing** - Configurable batch sizes for optimal performance
- **Automatic Retries** - Failed rows are automatically retried with configurable limits
- **External ID Support** - Upsert via `ir.model.data` for migration-safe imports
- **Per-Row Savepoints** - One failed row doesn't kill the entire batch
- **Pause/Resume** - Import can be paused and resumed at any time
- **Error Export** - Failed rows can be exported as CSV for manual review
- **Multi-File Imports** - Process multiple files in sequence with dependencies
- **Import Profiles** - Named configurations stored server-side in Odoo, with ZIP upload/download and RunConfig overrides
- **Smart Mapping** - Filename-to-model and header-to-field suggestions with confidence scoring
- **Drag & Drop** - File import via drag & drop with `.csv` filter
- **Validation Indicators** - Color-coded status (green/orange/red) gating import start
- **Saved Mappings** - Per-server filename-to-model associations with glob support
- **Searchable Field Select** - Dropdown with search by display name or technical name, type badges, relational sub-options
- **In-App Dialogs** - Custom alert/confirm/prompt dialogs (Electron blocks native `window.prompt`/`confirm`)
- **File Preview** - Expandable file rows showing CSV headers and first 4 sample rows
- **Persistent Navigation** - Top nav bar with Files / Configure / Profiles links and server info

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
│  /csv_import/run (savepoint per row, upsert via xml_id)     │
│  /csv_import/profile/* (CRUD, ZIP upload/download)          │
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
- Odoo 16+ instance with the `csv_import` addon installed

## Installation

```bash
# Install dependencies
npm install

# Install the Odoo addon
cp -r csv_import /path/to/odoo/addons/
# Then install via Odoo Apps menu
```

## Development

```bash
# Start development server (Vue + Electron)
npm run dev

# Run unit and integration tests
npm test

# Run tests in watch mode
npm run test:watch

# Run e2e tests (requires dev server running)
npm run test:e2e

# Type checking
npm run typecheck

# Linting
npm run lint
```

## Building

```bash
# Build for production
npm run build

# Package as desktop app
npm run package
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
│       └── profile.ts           # Profile ZIP select/upload/export IPC
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
│   │   ├── retryQueue.ts        # Failed row handling
│   │   ├── persistence.ts       # State recovery
│   │   └── profileValidator.ts  # Profile + ProfileDraft validation
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
│   │   ├── useDialog.ts              # In-app alert/confirm/prompt dialogs
│   │   ├── useImportValidation.ts    # Reactive validation state
│   │   ├── useProfileImport.ts       # Profile ZIP upload composable
│   │   └── useRunConfig.ts           # Override merge composable
│   ├── utils/
│   │   ├── logger.ts            # Structured logging
│   │   ├── smartMapping.ts      # Filename → Model scoring
│   │   ├── smartFieldMapping.ts # Header → Field scoring
│   │   ├── profileTemplates.ts  # Built-in profile templates
│   │   ├── profileExporter.ts   # ZIP export with overrides
│   │   ├── profileVersioning.ts # Version parse + compatibility
│   │   └── profileZip.ts        # ZIP generation helpers
│   ├── ui/                      # UI component wrappers
│   │   ├── Button.vue
│   │   ├── Input.vue
│   │   ├── Progress.vue
│   │   └── ...
│   ├── components/
│   │   ├── AppDialog.vue        # In-app modal dialog (alert/confirm/prompt)
│   │   ├── ErrorBoundary.vue
│   │   ├── FieldMappingTable.vue # Rich field mapping editor
│   │   ├── FieldSelect.vue      # Searchable field dropdown with type badges
│   │   ├── FieldSuggestion.vue  # Field suggestion with confidence
│   │   ├── FileDropZone.vue     # Drag & drop file import
│   │   ├── FileList.vue         # Sortable file table with preview
│   │   ├── FileMappingRow.vue   # Expanded file row content
│   │   ├── ImportSettings.vue   # Collapsible settings panel
│   │   ├── MappingStatus.vue    # Color-coded status indicator
│   │   ├── ModelSelect.vue      # Searchable model dropdown
│   │   ├── ModelSuggestion.vue  # Model suggestion with confidence
│   │   └── ProfileEditor.vue    # Tabbed profile editor with overrides
│   ├── views/
│   │   ├── LoginView.vue
│   │   ├── FilesView.vue
│   │   ├── ConfigView.vue
│   │   ├── RunView.vue
│   │   ├── ResultsView.vue
│   │   └── SavedMappingsView.vue
│   ├── App.vue
│   └── main.ts
├── csv_import/                  # Odoo addon
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
│   ├── unit/                    # Vitest unit tests (449 tests)
│   ├── integration/             # Integration tests
│   └── e2e/                     # Playwright e2e tests
└── docs/
    ├── project-overview.md
    ├── implementation-tickets.md
    ├── implementation-summary.md
    └── import-profiles.md
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

| Setting | Default | Description |
|---------|---------|-------------|
| `batchSize` | 100 | Rows per batch sent to Odoo |
| `retryLimit` | 3 | Max retry attempts per row |
| `retryDelayMs` | 1000 | Delay between retry attempts |

## External ID Handling

The tool supports two ID column types:

- **`id` column**: Uses Odoo's `ir.model.data` for upsert. Records are identified by external ID (xml_id), making imports migration-safe and repeatable.
- **`.id` column**: Direct database ID. Only use for same-database operations.

## Test Suite

### Unit Tests (449 tests)

| Module | Tests | Coverage |
|--------|-------|----------|
| csvParser | 14 | Parsing, delimiter detection, streaming |
| stateMachine | 31 | All state transitions, edge cases |
| retryQueue | 14 | Failed row tracking, CSV export |
| logger | 15 | Log levels, filtering, ring buffer |
| stores/session | 15 | Auth, multi-server, profiles |
| stores/config | 32 | Settings, mappings, CSV import/export |
| stores/files | 19 | Add/remove files, analysis, dedup, clearAll |
| stores/run | 24 | Progress tracking, ETA calculation |
| stores/profiles | 12 | Server-fetched profiles, cache TTL, delete |
| stores/savedMappings | 12 | Per-server storage, glob matching, suggestions |
| smartMapping | 21 | Filename scoring, Levenshtein, common patterns |
| smartFieldMapping | 26 | Header scoring, German aliases, auto-mapping |
| useDialog | 22 | Alert/confirm/prompt, sequential dialogs |
| profileValidator | 24 | Dependency validation, circular deps, ProfileDraft |
| importProfile | 25 | CSV parse/export roundtrips, rich field mappings |
| profileTemplates | 13 | Template listing, getTemplate, run settings |
| profileVersioning | 13 | Version parsing, Odoo compatibility |
| profileExporter | 16 | Override merging, CSV generators, version bump |
| profileApi | 6 | Server API with mocked IPC |
| runConfig | 12 | RunConfig create, override merging, hasOverrides |
| components/Button | 16 | Variants, sizes, loading state |
| components/Progress | 12 | Width calculation, clamping |
| integration/engine | 16 | Full import flow, abort, failures |

### E2E Tests (41 scenarios)

- Login flow with validation
- File selection and management
- Config view with settings modification
- Run view with progress monitoring
- Results view with export functionality
- Navigation between all views

## Design Decisions

1. **Vue owns import logic** - Odoo only validates and writes, keeping the backend simple
2. **CSS prefixed** (`csv-`) - Avoids conflicts with Odoo's styles
3. **Context isolation** - Secure IPC bridge, no Node.js in renderer
4. **Savepoint per row** - Transactional safety without batch-level rollbacks
5. **Streaming** - Memory efficiency for large files
6. **State machine** - Deterministic, pausable, resumable imports
7. **Server-side profile storage** - Profiles in Odoo, client is cache only
8. **Immutable profiles + RunConfig overrides** - Never edit profiles directly
9. **In-app dialogs** - Custom modal dialogs since Electron blocks native browser dialogs
10. **No external UI dependencies** - Native HTML5 drag & drop, CSS-only indicators, plain HTML components

## License

Proprietary - Ametras GmbH
