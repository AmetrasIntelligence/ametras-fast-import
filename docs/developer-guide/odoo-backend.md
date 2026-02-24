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

## Data Models

### `csv.import.profile`
Stores the import configurations.
*   `name`: Display name of the profile.
*   `data`: Binary field containing the ZIP file.
*   `odoo_min_version`: Version check for compatibility.
*   `description`: Text field for user notes.

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
