# Implementation Summary

## Status: Complete

All 17 EPICs implemented (0-16) plus post-EPIC improvements. 491+ tests passing (475 TypeScript + 26 Python).

---

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
│  csv.import.profile model (server-side profile storage)     │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Features

### Streaming CSV Processing
- Files processed in chunks (configurable batch size: 1-1000 rows)
- Constant memory usage regardless of file size
- Supports files >1GB

### Parallel Batch Processing (Worker Pool)
- 1-4 configurable workers for parallel batch processing
- Files processed sequentially (never parallel)
- Batches within a file processed in parallel
- Retries always serialized (single worker)
- Throughput display: `~1250 rows/sec (3 workers)`
- Warning for inefficient configs (>2 workers with <50 batch size)

### Import State Machine
```
IDLE → VALIDATING → RUNNING_FILE ↔ RUNNING_BATCH → COMPLETED
                         ↓              ↓
                      PAUSED      → RETRYING
                         ↓
                       IDLE (abort)
```

### Retry Queue
- Failed rows automatically retried (configurable limit: 0-10)
- Per-row savepoints in Odoo (one failure doesn't kill batch)
- Export failed rows as CSV for manual review

### External ID Support
- `id` column: Upsert via `ir.model.data` (migrations-safe)
- `.id` column: Direct DB ID (same-database only)

### Reference Resolution (NEW)
- External ID references (`field/id`) resolved via bulk prefetch
- Database ID references (`field/.id`) validated for standard models only
- Many2Many support: pipe or comma-delimited external IDs
- O(1) lookup performance regardless of row count
- Standard models for `/.id`: `res.country`, `res.currency`, `uom.uom`, `res.lang`
- See [docs/reference-resolution.md](reference-resolution.md) for details

### Import Profiles (EPIC 13, 16)
- Named configurations bundling mappings, sequence, settings, and field mappings
- CSV-based export/import format (human-readable, version-controllable)
- Explicit import order — never auto-derived from Odoo model relations
- Dependency validation with circular dependency detection
- Glob pattern support for filename matching
- Server-side storage in Odoo via `csv.import.profile` model (EPIC 16)
- ZIP upload/download via IPC bridge (multipart HTTP)
- Client-side cache with 5-minute TTL
- RunConfig override system — immutable profiles + mutable per-run overrides
- Profile versioning with Odoo compatibility checks
- Export with overrides (client-side ZIP generation via JSZip)

### Smart Mapping (EPIC 12)
- Filename-to-model suggestions with confidence scoring (Levenshtein distance, common patterns)
- CSV header-to-field suggestions with German/English alias dictionaries
- Saved mappings per server with simple glob pattern support
- All suggestions require explicit user confirmation — never auto-applied

### UX Improvements (EPIC 12 + Post-EPIC)
- Drag & drop file import with `.csv` filter
- Sortable file table with HTML5 native drag-to-reorder
- Collapsible import settings (collapsed by default)
- Color-coded validation indicators (green/orange/red)
- Searchable model dropdown with technical name display
- Searchable field dropdown with type badges and relational sub-options (ext ID / db ID)
- Validation composable gating import start
- In-app dialog system (alert/confirm/prompt) replacing blocked native browser dialogs
- File preview on expand showing headers and first 4 sample rows
- Persistent navigation bar with active route highlighting
- Profile picker in ConfigView with auto-apply of profile settings/mappings/sequence
- Smart field re-mapping when user manually changes model selection

---

## Test Suite

### Unit Tests: 491+ passing (475 TypeScript + 26 Python)

| Module | Tests | Coverage |
|--------|-------|----------|
| csvParser | 14 | Parsing, delimiter detection, streaming |
| stateMachine | 31 | All state transitions, edge cases |
| retryQueue | 14 | Failed row tracking, CSV export |
| logger | 15 | Log levels, filtering, ring buffer |
| workerPool | 15 | Queue, workers, throughput calculation |
| stores/session | 15 | Auth, multi-server, profiles |
| stores/config | 32 | Settings, mappings, CSV import/export |
| stores/files | 19 | Add/remove files, analysis, dedup, clearAll |
| stores/run | 24 | Progress tracking, ETA calculation |
| stores/profiles | 12 | Server-fetched profiles, cache TTL, delete |
| stores/savedMappings | 12 | Per-server storage, glob matching, suggestions |
| smartMapping | 21 | Filename scoring, Levenshtein, common patterns |
| smartFieldMapping | 29 | Header scoring, German aliases, auto-mapping, /id detection |
| useDialog | 22 | Alert/confirm/prompt, sequential dialogs |
| profileValidator | 24 | Dependency validation, circular deps, ProfileDraft |
| importProfile | 25 | CSV parse/export roundtrips, rich field mappings |
| profileTemplates | 13 | Template listing, getTemplate, run settings |
| profileZip | 7 | ZIP export, download helper |
| profileVersioning | 13 | Version parsing, Odoo compatibility |
| profileExporter | 16 | Override merging, CSV generators, version bump |
| profileApi | 6 | Server API with mocked IPC |
| runConfig | 12 | RunConfig create, override merging, hasOverrides |
| fieldMapping | 23 | Transform parse/serialize, m2m_ref, db_id, STANDARD_DB_ID_MODELS |
| fieldMappingValidator | 11 | Validation rules |
| batchExecutorMappings | 22 | Field mapping in batch execution, reference transforms |
| components/Button | 16 | Variants, sizes, loading state |
| components/Progress | 12 | Width calculation, clamping |
| integration/engine | 16 | Full import flow, abort, failures |

### Python Tests: 26 passing

| Module | Tests | Coverage |
|--------|-------|----------|
| reference_resolution | 26 | External ID detection, parsing, normalization, lookup |

### E2E Tests: 41 scenarios (Playwright)

- Login flow with validation
- File selection and management
- Config view with settings modification
- Run view with progress monitoring
- Results view with export functionality
- Navigation between all views

---

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

---

## Key Design Decisions

1. **Vue owns import logic** - Odoo only validates and writes
2. **CSS prefixed** (`csv-`) - Avoids Odoo style conflicts
3. **Context isolation** - Secure IPC bridge, no Node in renderer
4. **External ID support** - Upsert via `ir.model.data`
5. **Savepoint per row** - One failure doesn't kill the batch
6. **Streaming** - Constant memory regardless of file size
7. **State machine** - Deterministic, pausable, resumable imports
8. **Explicit import order** - Never auto-derived from Odoo model relations
9. **Suggestions, not automation** - Smart mapping always requires user confirmation
10. **No external UI dependencies added** - Native HTML5 drag & drop, CSS-only indicators
11. **In-app dialogs** - Custom modal dialogs since Electron blocks native `window.prompt`/`confirm`/`alert`
12. **Server-side profile storage** - Profiles stored in Odoo (`csv.import.profile`), client is cache only
13. **Immutable profiles + RunConfig overrides** - Profiles never edited directly; per-run changes via override system
14. **Numeric profile IDs** - `ImportProfile.id` is `number` (Odoo DB ID), not UUID string
15. **ZIP upload via IPC** - Multipart HTTP in Electron main process (renderer is sandboxed)
16. **Parallel batches, sequential files** - Worker pool for throughput, file order for dependencies
17. **Reference prefetch** - Bulk resolve external IDs before import for O(1) lookups
18. **Standard models for /.id** - Database IDs only allowed for stable reference data (countries, currencies, UoM)
