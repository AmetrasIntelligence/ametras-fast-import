# Import Profiles

## Overview

Import Profiles are named configurations that bundle everything needed to run a repeatable CSV import into Odoo. They solve the problem of having to manually reconfigure mappings, sequences, and settings every time you run the same type of import.

A profile captures:
- **File-to-Model Mappings** — which CSV files map to which Odoo models
- **Import Sequence** — the order files should be imported, with dependencies
- **Run Settings** — batch size, retry limits, error handling
- **Field Mappings** (optional) — which CSV columns map to which Odoo fields

## Core Principle

> **Import order is explicit, never auto-derived from Odoo model relations.**

The system does **not** attempt to detect dependencies from Odoo's relational model. This is intentional — Odoo models have circular relations, computed defaults differ between instances, partial creation is often allowed, and custom modules vary wildly. The user controls the order.

## Profile Structure

A profile consists of multiple CSV files, each handling one aspect of the configuration.

### 1. profile.csv — Metadata

```csv
key,value
name,Standard CRM Import
version,1.0
odoo_min_version,16.0
description,Partners before Contacts before Leads
```

| Key | Required | Description |
|-----|----------|-------------|
| `name` | Yes | Display name for the profile |
| `version` | No | Profile version (default: 1.0) |
| `odoo_min_version` | No | Minimum Odoo version required (e.g., 16.0) |
| `description` | No | Human-readable description |

### 2. mappings.csv — File-to-Model Assignments

```csv
filename,model
partners.csv,res.partner
contacts.csv,res.partner
leads.csv,crm.lead
```

Each row assigns a CSV filename (or glob pattern) to an Odoo model. Glob patterns use `*` as a wildcard — for example, `*_partners.csv` matches `2024_partners.csv`.

### 3. sequence.csv — Import Order with Dependencies

```csv
order,filename,requires
1,partners.csv,
2,contacts.csv,partners.csv
3,leads.csv,contacts.csv
```

| Column | Description |
|--------|-------------|
| `order` | Processing order (1-based, ascending) |
| `filename` | CSV filename (must match a mapping) |
| `requires` | Semicolon-separated list of files that must complete first |

Dependencies are validated before import starts. If a dependency is unmet, the import is blocked.

### 4. run_settings.csv — Execution Settings

```csv
key,value
batchSize,100
retryLimit,3
retryDelayMs,2000
stopOnFatalError,false
```

| Setting | Default | Description |
|---------|---------|-------------|
| `batchSize` | 100 | Number of rows sent per RPC call |
| `retryLimit` | 3 | Maximum retry attempts for failed rows |
| `retryDelayMs` | 2000 | Delay between retries in milliseconds |
| `stopOnFatalError` | false | Stop entire import on unrecoverable error |

### 5. field_mappings.csv — Column-to-Field Assignments (Optional)

```csv
filename,csv_column,odoo_field
partners.csv,name,name
partners.csv,email,email
partners.csv,kunde_nr,ref
contacts.csv,name,name
contacts.csv,parent,parent_id
```

This file is optional. If omitted, the user configures field mappings manually each run, with smart suggestions provided by the app.

## Using Profiles

### Creating a Profile

1. Configure an import normally (select files, map models, set field mappings)
2. Click **Save as Profile** on the Config page
3. Enter a name — the configuration is exported as a ZIP file
4. Upload the ZIP to the server via the Saved Mappings page

### Uploading a Profile

1. Go to the Saved Mappings page
2. Click **Upload Profile (ZIP)**
3. Select a ZIP file containing the profile CSVs
4. The server validates and stores the profile
5. It appears in the profile list for all users

### Loading a Profile

When a profile is active, it pre-fills:
- Model assignments for matching filenames
- Import sequence and dependencies
- Run settings (batch size, retries)
- Field mappings (if included in the profile)

Profiles are immutable once stored. Per-run customizations use the RunConfig override system — changes are tracked separately and can be reset.

### Exporting a Profile

Two export modes:
- **Clean export** — Downloads the original profile ZIP from the server
- **Export with overrides** — Generates a new ZIP locally with RunConfig overrides applied, with bumped minor version

Profiles export as a set of CSV files. This makes them:
- Human-readable and editable in any spreadsheet application
- Version-controllable (store in git)
- Shareable across teams
- Easy to inspect and debug

## Validation

Before an import starts, the profile is validated:

1. **File presence** — Every file in the sequence must exist in the selected files
2. **Model mapping** — Every file in the sequence must have a model assignment
3. **Dependency order** — Required files must appear before dependents in the sequence
4. **Circular dependencies** — No circular dependency chains are allowed
5. **Version check** — If `odoo_min_version` is set, the connected server must meet it

Validation errors block the import with clear error messages:

```
"contacts.csv" requires "partners.csv" which has not been processed yet
Required file "leads.csv" not found in selected files
```

## Saved Mappings (Per-Server)

Separate from profiles, the app stores **Saved Mappings** per server. These are simple filename-to-model associations that persist across sessions.

- Stored locally, scoped to the current Odoo server URL
- Used as suggestions (never auto-applied)
- Support simple glob patterns (`*_partners.csv`)
- Updated automatically when you complete an import

Saved mappings provide quick suggestions on the Config page — the user always confirms before applying.

## Smart Suggestions

The app provides two levels of automated suggestion:

### Model Suggestions (Filename → Odoo Model)

When a CSV file is loaded, the app scores it against all available Odoo models using:
- Exact matches on model display name or technical name parts
- Word similarity (Levenshtein distance)
- Common pattern dictionary (e.g., "customers" → `res.partner`)

Suggestions are presented with a confidence percentage. The user must explicitly click **Accept** — suggestions are never auto-applied.

### Field Suggestions (CSV Header → Odoo Field)

When a model is selected, CSV headers are scored against the model's fields using:
- Exact name/label matching
- German and English alias dictionaries (e.g., "telefon" → `phone`, "plz" → `zip`)
- Substring matching (for 3+ character headers)

Field suggestions auto-populate the mapping form but can be changed individually.

## What the System Does NOT Do

- Auto-derive import order from Odoo model relations
- Silently reorder files
- Auto-commit suggestions without user confirmation
- Create records to satisfy foreign keys
- Split imports across models implicitly
- Hide dependency failures

## Example Profiles

### Standard CRM Import

```
partners.csv    → res.partner     (order: 1)
contacts.csv    → res.partner     (order: 2, requires: partners.csv)
leads.csv       → crm.lead        (order: 3, requires: contacts.csv)
```

### Product Import

```
categories.csv  → product.category (order: 1)
products.csv    → product.template  (order: 2, requires: categories.csv)
variants.csv    → product.product   (order: 3, requires: products.csv)
```

### Sales Import

```
partners.csv    → res.partner       (order: 1)
products.csv    → product.template   (order: 2)
orders.csv      → sale.order         (order: 3, requires: partners.csv;products.csv)
lines.csv       → sale.order.line    (order: 4, requires: orders.csv)
```

## Technical Details

### Storage

- Profiles are stored server-side in Odoo via the `csv.import.profile` model
- The client maintains a local cache with a 5-minute TTL for performance
- Saved mappings are stored per-server under `savedMappings::{serverUrl}` (local Electron store)

### TypeScript Types

The core type is `ImportProfile` defined in `src/types/importProfile.ts`:

```typescript
interface ImportProfile {
  id: number              // Odoo DB ID (assigned on upload)
  name: string
  version: string
  odooMinVersion?: string
  description?: string
  mappings: ProfileMapping[]
  sequence: ProfileSequenceItem[]
  runSettings: RunSettings
  fieldMappings?: ProfileFieldMapping[]
  richFieldMappings?: FieldMapping[]
  createdAt: number
  updatedAt: number
}
```

The `RunConfig` type in `src/types/runConfig.ts` holds per-run overrides:

```typescript
interface RunConfig {
  id: string
  profileId: number
  runSettingsOverride: Partial<RunSettings>
  mappingsOverride: Map<string, Partial<ProfileMapping>>
  sequenceOverride: ProfileSequenceItem[] | null
  fieldMappingsOverride: Map<string, FieldMapping[]>
  createdAt: number
}
```

### Server Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/csv_import/profile/upload` | POST (HTTP) | Upload ZIP, validate, store |
| `/csv_import/profile/list` | POST (JSON) | List all profiles |
| `/csv_import/profile/<id>` | POST (JSON) | Get profile with full data |
| `/csv_import/profile/<id>/delete` | POST (JSON) | Delete profile |
| `/csv_import/profile/<id>/export` | GET (HTTP) | Download profile as ZIP |

### File Locations

| File | Purpose |
|------|---------|
| `src/types/importProfile.ts` | Type definitions and CSV parse/export |
| `src/types/runConfig.ts` | RunConfig override type |
| `src/types/fieldMapping.ts` | Rich field mapping types |
| `src/api/profileApi.ts` | Profile server API (upload, list, get, delete, export) |
| `src/stores/profiles.ts` | Server-fetched profiles with cache |
| `src/stores/savedMappings.ts` | Per-server saved filename→model mappings |
| `src/importer/profileValidator.ts` | Profile + ProfileDraft validation |
| `src/composables/useProfileImport.ts` | ZIP upload composable |
| `src/composables/useRunConfig.ts` | Override merge composable |
| `src/utils/profileExporter.ts` | ZIP export with overrides |
| `src/utils/profileVersioning.ts` | Version parse + Odoo compatibility |
| `src/utils/profileTemplates.ts` | Built-in profile templates |
| `src/utils/smartMapping.ts` | Filename→Model suggestion scoring |
| `src/utils/smartFieldMapping.ts` | Header→Field suggestion scoring |
| `src/composables/useImportValidation.ts` | Reactive validation state |
| `src/components/ProfileEditor.vue` | Tabbed profile editor with override indicators |
| `csv_import/models/csv_import_profile.py` | Odoo model for profile storage |
| `csv_import/controllers/profile_controller.py` | Server CRUD + ZIP parsing |
| `electron/ipc/profile.ts` | IPC handlers for ZIP select/upload/export |
