# Import Profiles & Mapping

## What's in a Profile?

A profile bundles everything needed for a repeatable CSV import:

- **File-to-Model Mappings**: Which CSV files map to which Odoo models
- **Field Mappings**: Column-to-field assignments for each file
- **Import Sequence**: Processing order and dependencies between files
- **Run Settings**: Batch size, workers, retry limits, encoding, etc.

### ZIP Structure

```
profile.zip
├── profile.csv        # Name, version, description
├── mappings.csv       # filename → model mappings
├── sequence.csv       # Import order and dependencies
├── field_mappings.csv # Column → field mappings (optional)
└── run_settings.csv   # Execution settings (optional)
```

## Profile Lifecycle

1. **Create**: Configure an import manually, then click **Save as Profile** to generate a ZIP.
2. **Upload**: Go to **Profiles** tab → **Upload Profile (ZIP)** to store on the server.
3. **Load**: Select a profile to auto-apply mappings, sequence, and settings to your files (matched by filename).
4. **Override**: Changes made after loading are tracked as session-specific overrides. Reset to return to the profile defaults, or export as a new version.

### Import Sequence & Dependencies

Files can be ordered with dependencies to ensure correct processing:

| File | Order | Requires |
|------|-------|----------|
| `partners.csv` | 1 | — |
| `contacts.csv` | 2 | `partners.csv` |
| `leads.csv` | 3 | `contacts.csv` |

## Profile Storage

| Backend | Requires Addon | Shared | Offline |
|---------|----------------|--------|---------|
| **Addon** (`csv.import.profile` model) | Yes | Yes (all employees) | No |
| **Attachment** (`ir.attachment` records) | No | No (owner only) | No |
| **Local** (Electron store, negative IDs) | No | No | Yes |

- **Addon installed**: Profiles are shared, server-validated, and visible in Odoo's backend.
- **Standalone mode**: Server profiles stored as `ir.attachment` (private to creating user). Local profiles available offline and can be pushed to server.

## Model Assignment

For each CSV file, select a target Odoo model (e.g., `res.partner`, `product.template`).

- **Smart Suggestions**: Auto-suggested based on filename with confidence scores.
- **Manual Selection**: Search by technical name or display label.
- **Saved Mappings**: Previous assignments are remembered for similar filenames.

## Field Mapping

Once a model is selected, the mapping table shows CSV headers on the left and Odoo fields on the right.

- **Auto-mapping**: A scoring engine handles exact matches, similarity, and common aliases (e.g., `Street` → `street`, `PLZ` → `zip`).
- **Relational fields**: Must choose a transform to specify how references are resolved.
- **Status indicator**: Shows if each mapping is valid.

## Transforms

| Transform | Description | Example Input | Odoo Value |
|-----------|-------------|---------------|------------|
| `passthrough` | No change | `John` | `John` |
| `m2o_ref` | External ID → Many2One | `base.res_partner_1` | `1` |
| `m2m_ref` | Pipe-separated External IDs → Many2Many | `tag1\|tag2` | `[(6, 0, [10, 11])]` |
| `db_id` | Integer ID for standard reference models | `57` | `57` |

### Transform Details

- **`m2o_ref`**: Queries `ir.model.data` for the external ID. IDs without a module prefix default to `__import__`.
- **`m2m_ref`**: Pipe-separated (`|`) external IDs. Replaces all existing relations.
- **`db_id`**: Restricted to stable reference models (`res.country`, `res.currency`, `uom.uom`, `res.lang`, `res.country.state`, `res.partner.title`). Validated before import.

### Automatic Header Patterns

| Header Pattern | Detected Transform | Example |
|----------------|--------------------|---------|
| `field/id` | `m2o_ref` or `m2m_ref` | `partner_id/id` |
| `field/.id` | `db_id` | `country_id/.id` |
| `id` | External ID column | `id` |
| `.id` | Database ID column | `.id` |

External ID normalization: `base.main_company` stays as-is, `main_company` becomes `__import__.main_company`, numeric strings are treated as database IDs.

## Import Strategies

The tool supports multiple strategies for create-vs-update resolution:

### 1. External ID (Upsert) — Preferred

Uses `ir.model.data` to identify records. If the external ID exists, the record is updated; otherwise created. Imports are idempotent and stable across instances.

### 2. Natural Key (Search)

Define one or more fields as "Search Keys". Odoo searches for a matching record — if exactly one is found, it's updated; if none, a new record is created. Requires the `ametras_fast_import` addon.

### 3. Database ID

Matches records by integer database ID. Restricted to standard reference models for safety.

### 4. Explicit Operation (`__op__`) — Addon Only

Control the operation per-row with a special CSV column:

| Value | Action |
|-------|--------|
| `create` | Always create (fails if external ID already exists) |
| `update` | Find and update (fails if not found) |
| `skip` | Row is ignored |

### Strategy Priority

When multiple identifiers are present: `__op__` → External ID → Natural Key → Database ID → Create (fallback).

### One2Many Handling

One2Many fields are imported using a flat parent-child pattern: create parents with external IDs first, then create children referencing parents via Many2One fields. Use the sequence feature to ensure correct ordering.
