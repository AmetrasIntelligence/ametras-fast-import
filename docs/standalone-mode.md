# Standalone Import Mode

## Overview

Standalone mode allows the CSV Import client to function without the `csv_import` Odoo addon installed. It uses Odoo's native `model.load()` API directly, providing basic import functionality for legacy systems or environments where the addon cannot be installed.

## How It Works

### Detection

On login, the client attempts to detect the `csv_import` addon by calling `/csv_import/info`. If this endpoint is not available, the client automatically switches to standalone mode.

### Import Method

- **Addon Mode**: Uses the `csv_import` addon's enhanced API with features like search key upsert, per-row error handling, and server-side profiles.
- **Standalone Mode**: Calls Odoo's standard `/web/dataset/call_kw` endpoint with `model.load()` method directly. Includes adaptive retry with geometric splitting and adaptive batch sizing.

## Features Comparison

| Feature | Addon Mode | Standalone Mode |
|---------|------------|-----------------|
| Basic CSV import | ✓ | ✓ |
| External ID (`id`) | ✓ | ✓ |
| Database ID (`.id`) | ✓ | ✓ |
| Relational fields (`field/id`, `field/.id`) | ✓ | ✓ |
| Server profiles | ✓ | ✗ |
| Local profiles | ✓ | ✓ |
| Search key upsert | ✓ | ✗ |
| Per-row error handling | ✓ | ✗ (per-batch, with geometric retry to isolate) |
| Adaptive retry (geometric splitting) | N/A | ✓ |
| Adaptive batch sizing | N/A | ✓ |
| Dry run validation | ✓ | ✗ |
| Row validation button | ✓ | ✗ |

## Visual Indicators

### Standalone Banner

When in standalone mode, a dismissible warning banner appears below the navigation bar:

```
⚠ Standalone Mode
csv_import addon not installed - using direct Odoo API
Some features unavailable: search key upsert, per-row error handling
```

### Log Messages

All standalone-related log messages are prefixed with `[standalone]` for easy filtering:

```
[standalone] Executing batch: 100 rows for product.template
[standalone] Batch complete for product.template: 98 success, 2 failed
[standalone] Row 45: Field 'categ_id' value not found
```

## Local Profiles

Since server profiles require the addon, standalone mode supports **local profiles** stored in the application's local storage.

### Importing a Local Profile

1. Go to **Profiles** tab
2. Click **Import Local Profile (ZIP)**
3. Select a profile ZIP file
4. Profile appears with a purple **[local]** badge

### Local Profile Storage

- **Electron mode**: Stored in electron-store under key `standalone-profiles`
- **Browser mode**: Stored in `localStorage` under key `standalone-profiles`
- Uses negative IDs to distinguish from server profiles
- Persists across application restarts
- Can be exported back to ZIP format

### Profile Save/Update

Local profiles can be saved and updated directly from the Import view:

1. Configure your file mappings and settings
2. Click **Save as Profile** to create a new local profile
3. Click **Update Profile** to save changes to the active profile (auto-increments the minor version)

### Profile ZIP Structure

```
profile.zip
├── profile.csv        # Name, version, description
├── mappings.csv       # filename → model mappings
├── sequence.csv       # Import order and dependencies
├── field_mappings.csv # CSV column → Odoo field mappings (optional)
└── run_settings.csv   # Batch size, encoding, etc. (optional)
```

## Adaptive Retry (Geometric Splitting)

Since standalone mode uses Odoo's `model.load()` which processes entire batches atomically, a single bad row causes the whole batch to fail. To isolate errors, standalone mode uses **geometric retry splitting** with a fixed depth of 3 levels.

When a batch fails, it is split into progressively smaller chunks until individual rows are reached:

```
Batch of 100 fails → retry in chunks of 10 → retry failed chunks row-by-row (size 1)
```

The chunk sizes follow a geometric progression: `chunkSize = initialSize^((depth-remaining)/(totalDepth-1))`. For a batch of 100 with retry depth 3, this produces:

| Level | Chunk Size | Description |
|-------|-----------|-------------|
| 0 | 100 | Initial batch |
| 1 | 10 | First retry level |
| 2 | 1 | Individual rows (always the bottom line) |

This ensures every failing row is individually identified with its specific Odoo error message, while successful rows from the original batch are retried in smaller groups and succeed.

## Adaptive Batch Sizing (Warmup)

Standalone mode uses a conservative warmup approach to learn data quality before sending large batches. Each file starts at batch size **1** and steps up through fixed levels: **1 → 10 → maxSize** (user-configured, capped at 100).

- **Increase**: After **100 consecutive successful rows**, step up one level
- **Decrease**: After **3 consecutive failed batches**, step down one level
- **Per-file reset**: Each new file starts fresh at level 0 (size 1)

Example with maxSize=100:

| Phase | Rows | Batch Size | API Calls | Description |
|-------|------|-----------|-----------|-------------|
| Warmup | 1-100 | 1 | 100 | Learning phase — single rows |
| Ramp-up | 101-200 | 10 | 10 | Data looks clean, larger batches |
| Full speed | 201+ | 100 | 1 per 100 | Maximum throughput |

If 3 batches fail at size 100, the adapter drops back to 10. After 100 more successful rows at 10, it steps back up to 100.

This approach avoids the problem of aggressive multiplicative scaling where a single bad batch of 100 rows triggers geometric retry (100→10→1), wasting many API calls. By starting small and proving data quality first, the warmup minimizes wasted work.

## Auto-Navigation

When a standalone import completes (all files processed) or is aborted, the Run view automatically navigates to the Results view, matching the behavior of addon-mode imports.

## Limitations

### Batch Size Constraints

In standalone mode, the batch size is constrained to the range 10-100 (vs 1-1000 in addon mode). If the global default (200) exceeds the standalone maximum, it is automatically clamped to 100 on login.

### No Dry Run

Odoo's native `model.load()` does not support dry run mode. The "Validate Random Row" button is disabled in standalone mode with the message: "Row validation not available in standalone mode".

### Per-Batch Errors Only (Mitigated by Geometric Retry)

Odoo's `model.load()` reports errors per-batch rather than per-row. However, the geometric retry mechanism (see above) automatically splits failed batches down to individual rows, so in practice each failing row is identified with its specific error message. The trade-off is additional API calls when errors occur.

### No Search Key Upsert

The addon's ability to upsert records based on custom search keys (e.g., `default_code` for products) is not available. Use external IDs (`id` column) or database IDs (`.id` column) for updates.

### No Server Profiles

Server-stored profiles are not available. Use local profiles instead.

## Code Organization

All standalone-related code is marked with:
```typescript
// standalone code flag (do not remove comment)
```

### Key Files

| File | Purpose |
|------|---------|
| `src/services/importMode.ts` | Detects addon availability |
| `src/services/standaloneProfiles.ts` | Local profile storage |
| `src/importer/standalone/executor.ts` | Batch execution via `model.load()` |
| `src/components/StandaloneBanner.vue` | Warning banner component |
| `electron/ipc/standalone/loader.ts` | IPC handler for load calls |
| `electron/ipc/standalone/detector.ts` | IPC handler for addon detection |

## Troubleshooting

### "Unexpected token '<'" Error

This occurs when an endpoint returns HTML instead of JSON (usually a 404 page). Common causes:
- Trying to use server profiles in standalone mode
- Trying to validate rows in standalone mode
- Session expired

### Import Seems Stuck

Check the browser console for `[standalone]` log messages. If batches are completing but the UI isn't updating, check for JavaScript errors.

### All Rows Failing

Check the error message - Odoo's `model.load()` may reject the entire batch if:
- A required field is missing
- A relational field value doesn't exist
- Data types are incorrect

## Technical Details

### API Call Format

```javascript
POST /web/dataset/call_kw
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model": "product.template",
    "method": "load",
    "args": [
      ["name", "default_code", "categ_id/id"],  // header
      [
        ["Product A", "PROD-001", "product.category_1"],
        ["Product B", "PROD-002", "product.category_2"]
      ]  // rows
    ],
    "kwargs": {}
  }
}
```

### Response Format

```javascript
{
  "jsonrpc": "2.0",
  "result": {
    "ids": [1, 2],  // Created/updated record IDs
    "messages": []   // Error messages (if any)
  }
}
```

### ID Column Formats

| Format | Example | Description |
|--------|---------|-------------|
| `id` | `product.template_1` | External ID (XML ID) |
| `.id` | `42` | Database ID |
| `field/id` | `product.category_1` | Relational external ID |
| `field/.id` | `5` | Relational database ID |

## Version History

- **1.2.0**: Warmup-based adaptive batch sizing
  - Conservative warmup: start at size 1, step through 1 → 10 → max
  - Level-up after 100 consecutive successful rows
  - Level-down after 3 consecutive failed batches
  - Per-file reset for fresh warmup on each file
- **1.1.0**: Adaptive retry and batch sizing
  - Geometric retry splitting (100 → 10 → 1) for per-row error isolation
  - Batch size range constrained to 10-100
  - Auto-clamp batch size on standalone mode detection
- **1.0.0**: Initial standalone mode implementation
  - Basic import via `model.load()`
  - Local profile storage
  - Standalone detection and banner
  - Retry support for standalone mode
