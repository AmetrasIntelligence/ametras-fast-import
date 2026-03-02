# Odoo Backend Integration

The `ametras_fast_import_addon` Odoo addon provides the server-side logic for data processing and profile storage.

## API Endpoints

All API calls are authenticated and require a valid Odoo session.

### `POST /ametras_fast_import/run` (JSON-RPC)
The main entry point for data import.
*   **Parameters**:
    *   `model`: Technical name of the Odoo model.
    *   `rows`: List of dictionaries containing field values.
    *   `use_external_id`: Boolean, enables Strategy 1 (Upsert).
    *   `search_keys`: List of fields for Strategy 2 (Natural Key).
    *   `dry_run`: Boolean, rolls back the transaction after processing.
*   **Logic**:
    1.  **Reference Prefetch**: Scans the batch for Many2One/Many2Many External IDs and resolves them in one query per model.
    2.  **Per-row Savepoints**: Each row is processed within a `cr.savepoint()`.
    3.  **Deterministic Upsert**: Follows the priority defined in the Technical Reference.
*   **Return**: A list of results per row (Success, Error Message, Action taken).

### `POST /ametras_fast_import/models` (JSON-RPC)
Returns a list of all non-transient models that the current user has 'create' access to.

### Profile Endpoints
*   `GET /ametras_fast_import/profile/list`: Lists all saved import profiles.
*   `POST /ametras_fast_import/profile/upload`: Accepts a ZIP file, validates its structure, and saves it.
*   `GET /ametras_fast_import/profile/<id>/export`: Downloads the profile as a ZIP file.

### Import Log Endpoints

| Endpoint | Type | Auth | Purpose |
|----------|------|------|---------|
| `POST /ametras_fast_import/log/create` | JSON-RPC | user | Create a log record at import start (`state='running'`). Links `attachment_ids` and stores initial `file_progress`. |
| `POST /ametras_fast_import/log/update` | JSON-RPC | user | Heartbeat + progress update. Updates `success_rows`, `failed_rows`, `file_progress`, and `heartbeat` timestamp. |
| `POST /ametras_fast_import/log/finalize` | JSON-RPC | user | Set final `state`, `finished_at`, final counts, and `error_log`. |
| `POST /ametras_fast_import/log/get` | JSON-RPC | user | Get full log details for resume, including `file_progress`, `attachment_ids`, and `error_log`. |
| `POST /ametras_fast_import/log/save` | JSON-RPC | user | Legacy endpoint — saves a completed log in one call (backward compat). |
| `POST /ametras_fast_import/log/list` | JSON-RPC | user | List recent import logs with pagination. |
| `GET /ametras_fast_import/log/<id>/error_csv` | HTTP | user | Download the error log as a CSV file. |

### Datetime Handling

JavaScript's `Date.toISOString()` produces ISO 8601 format (`"2026-03-02T17:07:23.797Z"`) but Odoo 16's `fields.Datetime` expects `"YYYY-MM-DD HH:MM:SS"`. The log controller includes a `_parse_datetime()` helper that converts between formats by replacing `T` with space and stripping milliseconds and `Z` suffix.

## Data Models

### `csv.import.profile`
Stores the import configurations.
*   `name`: Display name of the profile.
*   `data`: Binary field containing the ZIP file.
*   `odoo_min_version`: Version check for compatibility.
*   `description`: Text field for user notes.

### `csv.import.log`
Tracks import execution history with real-time progress.
*   `profile_name`: Name of the profile used (denormalized).
*   `profile_id`: Link to `csv.import.profile` (optional).
*   `user_id`: The user who ran the import.
*   `state`: Selection — `running`, `completed`, `failed`, `interrupted`.
*   `is_dry_run`: Whether this was a dry-run validation.
*   `started_at` / `finished_at`: Datetime fields.
*   `total_rows` / `success_rows` / `failed_rows`: Row counts.
*   `pending_rows`: Computed field (`total_rows - success_rows - failed_rows`).
*   `heartbeat`: Updated every 30s during import — used for stale detection.
*   `file_progress`: JSON text field tracking per-file `processedRanges` and counts.
*   `error_log`: JSON text field with per-row error details.
*   `attachment_ids`: Many2many link to `ir.attachment` for uploaded CSV files.
*   `duration_seconds`: Computed from `started_at` and `finished_at`.

## Cron Jobs

Two scheduled actions maintain log and file hygiene:

### Stale Log Detection (Hourly)
*   **Method**: `csv.import.log._cron_detect_stale_logs()`
*   **Logic**: Finds logs where `state='running'` AND (`heartbeat < now - 2h` OR `heartbeat IS NULL`). Sets `state='interrupted'` and `finished_at=now`.
*   **Purpose**: Detects imports abandoned by browser close, crash, or network disconnect.

### File Cleanup (Daily)
*   **Method**: `csv.import.log._cron_cleanup_attachments(retention_days=7)`
*   **Logic**: Finds completed/failed logs older than 7 days with attachments → unlinks and deletes `ir.attachment` records. Also cleans orphaned attachments (`res_model='ametras_fast_import.file'`, `res_id=0`, older than 7 days).
*   **Purpose**: Prevents disk usage growth from accumulated import files.

## Resume Workflow

Interrupted or failed imports can be resumed from the Odoo log form view:

1. User clicks **Resume Import** button (visible when `state in ('interrupted', 'failed')` and pending/failed rows > 0)
2. Opens the Vue client action with `resume_log_id` in context
3. Vue app calls `getImportLog()` to fetch log details including `file_progress` and `attachment_ids`
4. Engine computes which rows need processing: `(failed indices from error_log) ∪ (indices NOT in processedRanges)`
5. Import runs with row filtering — only pending and previously-failed rows are processed
6. The same log record is updated (not a new one)

## Prefetch Strategy

The import controller optimizes reference resolution (Many2One/Many2Many) using batch prefetching to minimize database queries.

### How It Works
1.  **Collection**: Before processing the rows in a batch, the controller scans all values for fields mapped as relational references.
2.  **Resolution**: It groups these references by model and performs a single `ir.model.data` search for each model to resolve all External IDs to Database IDs.
3.  **Caching**: The results are stored in a local map (dictionary) during the request.
4.  **O(1) Lookup**: During the actual import loop, each row's references are resolved via a simple map lookup instead of a database query.

### Performance Impact
Without prefetching, an import of 1,000 rows with 3 relational fields could trigger up to 3,000 extra queries. With prefetching, this is reduced to exactly **4 queries** (1 for each of the 3 models + 1 for the main model), regardless of the row count.

## Security

*   **Access Control**: The controller checks `check_access_rights('create')` and `check_access_rights('write')` for the target model before processing.
*   **Sudo Usage**: Prefetching of references (`ir.model.data`) is done with `sudo()` to ensure all public/standard references can be resolved regardless of the user's specific permissions on the metadata model, but the final record creation/update respects the user's actual permissions.
