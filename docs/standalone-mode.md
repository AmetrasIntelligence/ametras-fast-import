# Standalone Import Mode

## Overview

Standalone mode allows the CSV Import client to function without the `csv_import` Odoo addon installed. It uses Odoo's native `model.load()` API directly, providing basic import functionality for legacy systems or environments where the addon cannot be installed.

## How It Works

### Detection

On login, the client attempts to detect the `csv_import` addon by calling `/csv_import/info`. If this endpoint is not available, the client automatically switches to standalone mode.

### Import Method

- **Addon Mode**: Uses the `csv_import` addon's enhanced API with features like search key upsert, per-row error handling, and server-side profiles.
- **Standalone Mode**: Calls Odoo's standard `/web/dataset/call_kw` endpoint with `model.load()` method directly.

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
| Per-row error handling | ✓ | ✗ (per-batch only) |
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
[standalone] Executing batch: 200 rows for product.template
[standalone] Batch complete for product.template: 198 success, 2 failed
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

- Stored in electron-store under key `standalone-profiles`
- Uses negative IDs to distinguish from server profiles
- Persists across application restarts
- Can be exported back to ZIP format

### Profile ZIP Structure

```
profile.zip
├── profile.csv        # Name, version, description
├── mappings.csv       # filename → model mappings
├── sequence.csv       # Import order and dependencies
├── field_mappings.csv # CSV column → Odoo field mappings (optional)
└── run_settings.csv   # Batch size, encoding, etc. (optional)
```

## Limitations

### No Dry Run

Odoo's native `model.load()` does not support dry run mode. The "Validate Random Row" button is disabled in standalone mode with the message: "Row validation not available in standalone mode".

### Per-Batch Errors Only

Errors are reported per-batch rather than per-row. If a batch fails, all rows in that batch are marked as failed. The error message from Odoo indicates which row caused the issue.

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

- **1.0.0**: Initial standalone mode implementation
  - Basic import via `model.load()`
  - Local profile storage
  - Standalone detection and banner
  - Retry support for standalone mode
