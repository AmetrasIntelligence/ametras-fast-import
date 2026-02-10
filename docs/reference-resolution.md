# Reference Resolution for CSV Import

## Core Principle

> **CSV data carries *references*, never raw IDs.**
> Import resolves references deterministically.

This ensures:
- **Portability** across Odoo environments (dev → staging → production)
- **Retry safety** — reimports produce identical results
- **Multi-worker safety** — parallel batches don't conflict
- **Idempotent imports** — same CSV always produces same records

---

## Reference Carriers (Two Supported)

### 1. External IDs (Primary, Recommended)

**CSV Header Pattern:** `field/id`

**Examples:**
```csv
categ_id/id,partner_id/id,tag_ids/id
product_category#8969,res_partner_id#2093,tag_red|tag_blue
```

**Resolution:** Via Odoo's `ir.model.data` table

**Format Options:**
| Format | Example | Behavior |
|--------|---------|----------|
| `module.name` | `base.de`, `purchase_stock.route_warehouse0_buy` | Explicit module lookup |
| `name` (shorthand) | `product_category#8969` | Auto-prefixed to `__import__.name` |

**Best Practice:** Always use external IDs for relational fields. They survive database migrations and work across environments.

### 2. Database IDs (Hybrid, Validated)

**CSV Header Pattern:** `field/.id`

**Examples:**
```csv
country_id/.id,currency_id/.id,uom_id/.id
57,1,1
```

**Validation:** Only allowed for **standard Odoo reference data**:

| Model | Description |
|-------|-------------|
| `res.country` | Countries (ISO-standardized) |
| `res.currency` | Currencies (ISO-standardized) |
| `uom.uom` | Units of measure (Odoo standard) |
| `res.lang` | Languages (ISO-standardized) |
| `res.country.state` | Country states/provinces |
| `res.partner.title` | Partner titles (Mr., Mrs., etc.) |

**Behavior:**
- Passed as integer to Odoo
- Record existence validated before import
- Warning emitted recommending migration to external IDs

**Why Restricted:** Database IDs are environment-specific. Using `country_id/.id=57` might reference "Germany" in one database but "France" in another. Standard reference data is the exception because Odoo seeds these consistently.

---

## Transform Types

### `m2o_ref` — Many2One Reference

**Mapping Entry:**
```csv
filename,csv_header,odoo_field,required,transform,notes
10_product_template.csv,categ_id/id,categ_id,false,m2o_ref:product.category,Category external ID
```

**CSV Data:**
```csv
categ_id/id
product_category#8969
```

**Resolution:**
```python
ref_value = "product_category#8969"
record = env.ref("__import__.product_category#8969")
vals["categ_id"] = record.id  # Integer ID for Odoo
```

### `m2m_ref` — Many2Many Reference

**Mapping Entry:**
```csv
filename,csv_header,odoo_field,required,transform,notes
10_product_template.csv,route_ids/id,route_ids,false,m2m_ref:stock.route,Routes external IDs
```

**CSV Data:** Pipe-delimited (`|`) or comma-delimited (`,`) external IDs
```csv
route_ids/id
purchase_stock.route_warehouse0_buy|stock.route_warehouse0_mto
```

**Resolution:**
```python
ref_values = value.split("|")  # or ","
ids = [env.ref(x).id for x in ref_values]
vals["route_ids"] = [(6, 0, ids)]  # Replace all command
```

### `db_id` — Database ID (Standard Data Only)

**Mapping Entry:**
```csv
filename,csv_header,odoo_field,required,transform,notes
10_product_template.csv,uom_id/.id,uom_id,false,db_id:uom.uom,Unit of measure database ID
```

**CSV Data:**
```csv
uom_id/.id
1
```

**Resolution:**
```python
record = env["uom.uom"].browse(int(value)).exists()
if not record:
    raise ValueError(f"Record {value} not found in uom.uom")
vals["uom_id"] = record.id
```

---

## Prefetch Strategy

The import controller optimizes reference resolution using batch prefetching:

### How It Works

1. **Collect** — Scan all rows for external ID references before processing
2. **Resolve** — Single query per model to fetch all referenced IDs
3. **Lookup** — O(1) map access during row processing

### Example

```python
# Phase 1: Collection (before import loop)
refs_by_model = {
    "product.category": {"product_category#8969", "product_category#1234"},
    "res.partner": {"res_partner_id#2093"}
}

# Phase 2: Bulk resolution (one query per model)
ref_map = {}
for model, ext_ids in refs_by_model.items():
    imd_records = env["ir.model.data"].search([
        ("model", "=", model),
        ("name", "in", list(ext_ids))
    ])
    for imd in imd_records:
        ref_map[(model, imd.module, imd.name)] = imd.res_id

# Phase 3: O(1) lookup during row processing
categ_id = ref_map[("product.category", "__import__", "product_category#8969")]
```

### Performance Impact

| Rows | Without Prefetch | With Prefetch |
|------|------------------|---------------|
| 100 | ~200 queries | ~3 queries |
| 1000 | ~2000 queries | ~3 queries |
| 10000 | ~20000 queries | ~3 queries |

The number of queries equals `1 + (number of unique comodels referenced)`, regardless of row count.

---

## One2Many Handling (Flat Mode)

One2Many fields are **NOT** imported inline. The tool uses flat CSV files with parent-child references.

### Correct Pattern

1. Parent CSV creates parent records with external IDs
2. Child CSV references parent via Many2One field

### Example

**`04_res_partner.csv`** (parent):
```csv
id,name
res_partner_id#123,ACME Corp
```

**`06_res_partner_bank.csv`** (child):
```csv
partner_id/id,acc_number,id
res_partner_id#123,DE89370400440532013000,bank_account#456
```

The profile's `sequence.csv` ensures parents import before children:
```csv
order,filename
4,04_res_partner.csv
6,06_res_partner_bank.csv
```

---

## Validation Rules

### Import Blocked If:

| Error | Description |
|-------|-------------|
| Raw ID in `/id` field | CSV value is numeric where external ID pattern expected |
| Unknown `/.id` model | Database ID used for non-standard model |
| Reference not found | External ID doesn't exist after prefetch |
| Ambiguous natural key | Search returns 0 or >1 records |
| Missing required reference | Required relational field is empty |

### Warning (Import Continues):

| Warning | Description |
|---------|-------------|
| `/.id` usage | Recommends migration to external IDs for portability |

---

## Smart Mapping for Reference Columns

The smart field mapping system automatically recognizes reference column patterns:

### Column Header Patterns

| Pattern | Detection | Suggested Transform |
|---------|-----------|---------------------|
| `field/id` | External ID reference | `m2o_ref:comodel` or `m2m_ref:comodel` |
| `field/.id` | Database ID reference | `db_id:comodel` |

### Example Auto-Detection

For CSV header `categ_id/id` mapped to model `product.template`:

1. System detects `/id` suffix
2. Looks up `categ_id` field → finds `many2one` to `product.category`
3. Suggests transform `m2o_ref:product.category`

For CSV header `country_id/.id`:

1. System detects `/.id` suffix
2. Looks up `country_id` field → finds `many2one` to `res.country`
3. Checks if `res.country` is in STANDARD_DB_ID_MODELS → yes
4. Suggests transform `db_id:res.country`
5. If not standard model, suggests migration to `/id` format

---

## field_mappings.csv Format

The `field_mappings.csv` file in a profile defines column-to-field mappings with transforms:

```csv
filename,csv_header,odoo_field,required,transform,notes
04_res_partner.csv,id,id,true,,External ID for upsert
04_res_partner.csv,name,name,true,,Partner name
04_res_partner.csv,country_id/.id,country_id,false,db_id:res.country,Country database ID
04_res_partner.csv,parent_id/id,parent_id,false,m2o_ref:res.partner,Parent partner external ID
10_product_template.csv,categ_id/id,categ_id,false,m2o_ref:product.category,Category external ID
10_product_template.csv,route_ids/id,route_ids,false,m2m_ref:stock.route,Routes external IDs
10_product_template.csv,uom_id/.id,uom_id,false,db_id:uom.uom,Unit of measure database ID
```

### Column Definitions

| Column | Description |
|--------|-------------|
| `filename` | CSV file this mapping applies to |
| `csv_header` | Column header in CSV (exact match) |
| `odoo_field` | Target field on Odoo model |
| `required` | If `true`, import fails when column empty |
| `transform` | Transform type and target model |
| `notes` | Human-readable description |

### Transform Format

| Transform | Format | Example |
|-----------|--------|---------|
| Passthrough | (empty) | Scalar fields |
| Many2One ref | `m2o_ref:model.name` | `m2o_ref:res.partner` |
| Many2Many ref | `m2m_ref:model.name` | `m2m_ref:stock.route` |
| Database ID | `db_id:model.name` | `db_id:res.country` |

---

## TypeScript Types

### FieldTransform

```typescript
type FieldTransform =
  | { type: 'passthrough' }
  | { type: 'm2o_ref'; model: string }
  | { type: 'm2m_ref'; model: string }
  | { type: 'db_id'; model: string }
```

### STANDARD_DB_ID_MODELS

```typescript
const STANDARD_DB_ID_MODELS = new Set([
  'res.country',
  'res.currency',
  'uom.uom',
  'res.lang',
  'res.country.state',
  'res.partner.title'
])
```

---

## Backend Implementation

### Key Files

| File | Purpose |
|------|---------|
| `csv_import/controllers/import_controller.py` | Reference prefetch and resolution |
| `src/types/fieldMapping.ts` | Transform type definitions |
| `src/importer/batchExecutor.ts` | Frontend transform application |

### Python Methods

| Method | Purpose |
|--------|---------|
| `_prefetch_references()` | Collect and bulk-resolve external IDs |
| `_resolve_row()` | Apply resolutions to single row |
| `_is_external_id()` | Check if value is external ID (non-numeric string) |
| `_parse_refs()` | Parse pipe/comma-delimited M2M references |
| `_normalize_ext_id()` | Convert to (module, name) tuple |
| `_lookup_ref()` | O(1) lookup from prefetch map |

---

## Migration Guide

### From Raw IDs to External IDs

**Before (fragile):**
```csv
partner_id
42
```

**After (portable):**
```csv
partner_id/id
res_partner_id#42
```

### Steps:

1. Export existing data with external IDs enabled
2. Update CSV headers to use `/id` suffix
3. Update profile's `field_mappings.csv` with `m2o_ref` transforms
4. Test with `dry_run: true` before actual import

### From /.id to /id (Standard Data)

**Before:**
```csv
country_id/.id
57
```

**After:**
```csv
country_id/id
base.de
```

Use Odoo's standard external IDs for reference data (e.g., `base.de` for Germany, `base.USD` for US Dollar).
