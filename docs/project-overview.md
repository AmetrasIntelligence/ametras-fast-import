# CSV Import Tool — Technical Overview

## Design Principle

> **Vue owns import logic. Odoo validates and writes.**

- Electron-first, Odoo-embedding optional
- Thin Odoo addon (endpoints for import + profiles)
- Parallel batch processing within files (1-4 workers)
- Reference resolution via prefetch for O(1) lookups

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Electron Main Process                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ File Dialog │  │ OdooSession  │  │ Credential     │  │
│  │ (FS Access) │  │ Manager      │  │ Store          │  │
│  └──────┬──────┘  └──────┬───────┘  └────────────────┘  │
│         │                │                               │
│         └────────────────┴──────────────┬───────────────│
│                                         │ IPC Bridge    │
├─────────────────────────────────────────┴───────────────┤
│  Vue Renderer (Context Isolated)                         │
│  ┌──────────┐  ┌───────────┐  ┌────────────────────────┐│
│  │ UI       │  │ Import    │  │ Stores                 ││
│  │ (shadcn) │  │ Engine    │  │ (session/config/run/   ││
│  │          │  │           │  │  files/profiles/       ││
│  │          │  │           │  │  savedMappings)        ││
│  └──────────┘  └───────────┘  └────────────────────────┘│
└─────────────────────────────────────────────────────────┘
            │
            ▼ JSON-RPC
┌─────────────────────────────────────────────────────────┐
│  Odoo 16+ Backend                                        │
│  /csv_import/run (savepoint per row, upsert via xml_id)  │
│  /csv_import/profile/* (CRUD, ZIP upload/download)       │
│  csv.import.profile model (server-side profile storage)  │
└─────────────────────────────────────────────────────────┘
```

---

## Odoo ID-Handling (Critical)

### ID Column Types

| Type | Column | Format | Use Case |
|------|--------|--------|----------|
| **External ID** | `id` | `module.xml_id` | Stable, migration-safe, upsert-enabled |
| **Database ID** | `.id` | Integer | Same-database roundtrip only |

### Relational Field References

| Pattern | Resolution | Example |
|---------|------------|---------|
| `field/id` | External ID via `ir.model.data` | `partner_id/id` → `res_partner_id#123` |
| `field/.id` | Database ID (standard models only) | `country_id/.id` → `57` |

**Standard Models for `/.id`:** `res.country`, `res.currency`, `uom.uom`, `res.lang`, `res.country.state`, `res.partner.title`

### Reference Resolution

The backend prefetches all external IDs before import:
1. Scan rows for references in relational fields
2. Bulk query `ir.model.data` (one query per model)
3. Build O(1) lookup map for row processing

**See:** [docs/reference-resolution.md](reference-resolution.md) for full details.

### Import Behavior

| Column | Behavior |
|--------|----------|
| `id` | Upsert: update if exists, create + `ir.model.data` entry if not |
| `.id` | Direct DB lookup (same-database roundtrip only) |
| `field/id` | Resolve external ID → integer before write |
| `field/.id` | Validate existence, pass integer (warning emitted) |

**Tool Decision:** Primary support for External IDs (`id`, `/id`). Database IDs (`/.id`) only for standard reference data.

---

## UI Framework: shadcn/ui + Vue

### Warum shadcn

- Copy-in Components (keine Runtime-Dependency)
- Radix UI Primitives + Tailwind
- Electron-kompatibel, Odoo-embedding möglich

### Guardrails (Mandatory)

**1. CSS Scoping**
```ts
// tailwind.config.ts
export default {
  prefix: "csv-",
  corePlugins: { preflight: false }
}
```

**2. App Wrapper**
```vue
<div id="csv-import-app">
  <RouterView />
</div>
```

**3. UI Abstraction Layer**
```
src/ui/
├── Button.vue      // re-exports shadcn
├── Input.vue
├── Dialog.vue
└── index.ts
```

Feature-Code importiert nur aus `@/ui/*`, nie direkt aus shadcn.

**4. Erlaubte Components**
- Button, Input, Select, Checkbox
- Table, DataTable
- Dialog, AlertDialog
- Progress, Toast
- Card, Tabs

**5. Custom Components (no external dependencies)**
- FileDropZone, FileList, ImportSettings
- ModelSelect, ModelSuggestion, FieldSuggestion, FieldSelect
- FieldMappingTable, FileMappingRow, MappingStatus
- ProfileEditor, AppDialog

**6. Verbotene Components**
- Layout primitives, Navigation shells
- Theme toggles, Full-page templates

---

## Configuration Model

### Run Settings
```ts
interface RunSettings {
  batchSize: number      // default: 200, range: 1-1000
  workers: number        // default: 1, range: 1-4
  retryLimit: number     // default: 3, range: 0-10
  retryDelayMs: number   // default: 2000
  stopOnFatalError: boolean
  encoding: string       // default: 'utf-8'
  delimiter: string      // default: ',' (auto-detect)
  skipHeader: boolean    // default: true
  dryRun: boolean        // default: false
  lang: string           // default: '' (use Odoo default)
}
```

### Worker Pool

The import engine uses a worker pool for parallel batch processing:

- **1-4 workers** — configurable per import run
- **Files sequential** — never parallel across files
- **Batches parallel** — independent batches within a file
- **Retries serial** — always single-threaded for predictability

```
File 1: [Batch 1] [Batch 2] [Batch 3] → Worker Pool → [Results]
                  ↓         ↓         ↓
               Worker 1  Worker 2  Worker 3
```

**Throughput display:** `~1250 rows/sec (3 workers)` shown during import.

### File Mappings
```ts
interface FileMapping {
  filename: string       // basename only
  model: string          // e.g. "res.partner"
  idColumn?: string      // "id" | ".id" | undefined
}
```

### Import Sequence
```ts
type ImportSequence = string[]  // filenames in order
```

Alle Configs CSV-exportierbar für Wiederverwendung.

---

## Import State Machine

```
IDLE → VALIDATING → RUNNING_FILE → RUNNING_BATCH → COMPLETED
                         ↓              ↓
                      RETRYING ←────────┘
                         ↓
                      FAILED (stopOnFatalError)
```

Invarianten:
- Genau eine Datei aktiv
- Genau ein Batch aktiv
- Retry nur für fehlgeschlagene Rows

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
│   │   ├── profileValidator.ts  # Profile + ProfileDraft validation
│   │   └── fieldMappingValidator.ts  # Field mapping validation
│   ├── stores/
│   │   ├── session.ts           # Auth state
│   │   ├── config.ts            # Import settings
│   │   ├── files.ts             # Selected files + analyses
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
│   │   ├── Select.vue
│   │   ├── Checkbox.vue
│   │   ├── Progress.vue
│   │   ├── Card.vue
│   │   ├── Table.vue
│   │   └── index.ts
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

## Odoo Addon

```
csv_import/
├── __manifest__.py
├── models/
│   ├── __init__.py
│   └── csv_import_profile.py   # csv.import.profile model
├── controllers/
│   ├── __init__.py
│   ├── import_controller.py    # Import run endpoint (savepoints per row)
│   └── profile_controller.py   # Profile CRUD + ZIP upload/download
├── security/
│   └── ir.model.access.csv
└── static/                     # Vue build (embedded mode)
```

Keine Business-Logik im Addon — nur Validation, ACL-Check, und `Model.create()` mit Savepoints.
Profile-Endpoint: CRUD + ZIP upload/download für `csv.import.profile` Records.

---

## Embedded Mode (Future)

Änderungen für Odoo-Embedding:
- Login-View deaktiviert
- `OdooClient` → `WebOdooClient(window.odoo)`
- Vue-Build via Addon-Assets serviert
- CSS via `#csv-import-app` scope isoliert

Keine Änderungen an: Engine, Config, Retry, State Machine.
