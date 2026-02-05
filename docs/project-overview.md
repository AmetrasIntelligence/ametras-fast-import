# CSV Import Tool — Technical Overview

## Design Principle

> **Vue owns import logic. Odoo validates and writes.**

- Electron-first, Odoo-embedding optional
- Thin Odoo addon (single endpoint)
- Sequential batch processing (no parallelism)

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
│  │ (shadcn) │  │ Engine    │  │ (session/config/run)   ││
│  └──────────┘  └───────────┘  └────────────────────────┘│
└─────────────────────────────────────────────────────────┘
            │
            ▼ JSON-RPC
┌─────────────────────────────────────────────────────────┐
│  Odoo Backend                                            │
│  /csv_import/run (single endpoint, savepoints per row)   │
└─────────────────────────────────────────────────────────┘
```

---

## Odoo ID-Handling (Critical)

Zwei ID-Typen mit unterschiedlichem Verhalten:

| Typ | Spalte | Format | Verwendung |
|-----|--------|--------|------------|
| **External ID** | `id` | `module.xml_id` | Stabil, migrations-sicher, Upsert-fähig |
| **Database ID** | `.id` | Integer | Nur gleiche DB, kein Upsert |

**Relationen in CSV:**
- `partner_id/id` → verknüpft via External ID
- `partner_id/.id` → verknüpft via DB-ID (riskant)

**Import-Verhalten:**
- Mit `id`: Update wenn vorhanden, sonst Create + `ir.model.data` Eintrag
- Mit `.id`: Nur Roundtrip in derselben DB möglich
- Export ohne XML-ID erzeugt `__export__...` IDs (temporär)

**Tool-Entscheidung:** Primär External IDs (`id`) unterstützen, `.id` nur für explizite Same-DB-Szenarien.

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
- ModelSelect, ModelSuggestion, FieldSuggestion
- FileMappingRow, MappingStatus

**6. Verbotene Components**
- Layout primitives, Navigation shells
- Theme toggles, Full-page templates

---

## Configuration Model

### Run Settings
```ts
interface RunSettings {
  batchSize: number      // default: 100
  retryLimit: number     // default: 3
  retryDelayMs: number   // default: 2000
  stopOnFatalError: boolean
}
```

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
src/
├── api/
│   ├── odooClient.ts        # RPC abstraction
│   └── types.ts             # Odoo response types
├── electron/
│   ├── main.ts              # Main process
│   ├── preload.ts           # IPC bridge
│   └── ipc/
│       ├── files.ts         # File selection handlers
│       ├── odoo.ts          # Odoo proxy handlers
│       └── store.ts         # Persistent storage
├── importer/
│   ├── engine.ts            # Core import logic
│   ├── stateMachine.ts      # State transitions
│   ├── batchExecutor.ts     # Batch processing
│   ├── retryQueue.ts        # Failed row handling
│   ├── persistence.ts       # State recovery
│   └── profileValidator.ts  # Profile dependency validation
├── stores/
│   ├── session.ts           # Auth state
│   ├── config.ts            # Run settings
│   ├── files.ts             # Selected files
│   ├── run.ts               # Current import state
│   ├── profiles.ts          # Import profile CRUD
│   └── savedMappings.ts     # Per-server saved mappings
├── types/
│   └── importProfile.ts     # Profile types + CSV parse/export
├── composables/
│   └── useImportValidation.ts  # Reactive validation state
├── utils/
│   ├── logger.ts            # Structured logging
│   ├── smartMapping.ts      # Filename → Model scoring
│   └── smartFieldMapping.ts # Header → Field scoring
├── ui/                      # shadcn wrappers
│   ├── Button.vue
│   ├── DataTable.vue
│   └── ...
├── components/
│   ├── ErrorBoundary.vue
│   ├── FileDropZone.vue     # Drag & drop file import
│   ├── FileList.vue         # Sortable file table
│   ├── ImportSettings.vue   # Collapsible settings panel
│   ├── ModelSelect.vue      # Searchable model dropdown
│   ├── ModelSuggestion.vue  # Model suggestion with confidence
│   ├── FieldSuggestion.vue  # Field suggestion with confidence
│   ├── FileMappingRow.vue   # Expanded file row content
│   └── MappingStatus.vue    # Color-coded status indicator
├── views/
│   ├── LoginView.vue
│   ├── FilesView.vue
│   ├── ConfigView.vue
│   ├── RunView.vue
│   ├── ResultsView.vue
│   └── SavedMappingsView.vue
└── App.vue
```

---

## Odoo Addon (Minimal)

```
csv_import/
├── __manifest__.py
├── controllers/
│   └── import_controller.py   # Single endpoint
├── security/
│   └── ir.model.access.csv
└── static/                    # Vue build (embedded mode)
```

Keine Business-Logik im Addon — nur Validation, ACL-Check, und `Model.create()` mit Savepoints.

---

## Embedded Mode (Future)

Änderungen für Odoo-Embedding:
- Login-View deaktiviert
- `OdooClient` → `WebOdooClient(window.odoo)`
- Vue-Build via Addon-Assets serviert
- CSS via `#csv-import-app` scope isoliert

Keine Änderungen an: Engine, Config, Retry, State Machine.
