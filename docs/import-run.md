# Running Imports & Results

## Execution Flow

1. **Validation**: Model existence, field validity, dependency check, and a sample dry-run of the first rows.
2. **File streaming**: CSV files are opened and streamed in configurable batches.
3. **Worker allocation**: Workers (up to 4 in addon mode, up to 3 in standalone) pull batches from a shared queue.
4. **Batch processing**: Each batch is sent to Odoo via JSON-RPC. In addon mode, per-row savepoints isolate errors. In standalone mode, failed batches are geometrically split (e.g., 100 → 10 → 1) and concurrency errors are retried with backoff.
5. **Progress reporting**: Real-time per-row status updates in the UI.

## Monitoring

- **Overall progress**: Percentage bar for the entire import
- **Per-file progress**: Individual bars with success/failure counters
- **ETA**: Based on current throughput
- **Recent errors**: Live error feed

## Controls

| Action | Behavior |
|--------|----------|
| **Pause** | Stops sending new batches; active batches finish |
| **Resume** | Continues from where paused |
| **Skip File** | Skips the current file and moves to the next |
| **Abort** | Stops completely; navigates to Results |

## Error Handling

- **Network errors**: Engine pauses all workers and auto-resumes when the server is reachable (exponential backoff health check).
- **Concurrency errors** (standalone): Transient database locks are retried with jitter (up to 3 attempts per batch) before falling through to batch splitting.
- **Data errors**: Rows are retried up to the configured limit. Non-retryable errors mark the row as failed (or halt the import if "Stop on Fatal Error" is enabled).
- **Adaptive retry** (standalone): Failed batches are split geometrically to isolate individual failing rows.

## Results

After completion or abort, the Results view shows:

- **Per-file breakdown**: Success count, failure count, total retries
- **Error details**: Exact Odoo error message per failed row
- **Export Errors**: Download a CSV of failed rows with an `__error__` column. Fix the data, remove the column, and re-import.
- **Full Report**: Download a JSON report with all results.
