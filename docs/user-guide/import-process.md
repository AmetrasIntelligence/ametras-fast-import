# Running the Import

The **Run** view is the control center for your data import.

## Validation Phase

Before any data is sent to Odoo, the tool performs a final validation:
*   **Model Existence**: Checks if all target models exist and the user has access.
*   **Field Validity**: Ensures all mapped fields exist on the target models.
*   **Dependency Check**: Verifies that the sequence is logical and all required files are present.
*   **Sample Run**: Performs a small dry-run of the first few rows to catch immediate issues (e.g., data type mismatches).

If any validation errors are found, the import is blocked until they are resolved.

## The Execution Flow

1.  **File Initialization**: The tool opens the CSV file and initializes the streaming reader.
2.  **Worker Allocation**: Based on your settings, 1 to 4 workers are started.
3.  **Batch Processing**:
    *   Workers read rows from the CSV.
    *   References (Many2One/Many2Many) are resolved.
    *   Data is grouped into batches.
    *   Each batch is sent to Odoo via a JSON-RPC call.
4.  **Savepoints**: Odoo processes each row within a sub-transaction (savepoint). Successes are committed; failures are rolled back individually within the batch.
5.  **Progress Reporting**: The client receives per-row status updates and updates the UI in real-time.

## Monitoring

The UI provides several metrics:
*   **Overall Progress**: A percentage bar for the entire import project.
*   **Per-File Progress**: Individual bars for each file.
*   **Counters**: Real-time count of Successes, Retries, and Failures.
*   **ETA**: Estimated time remaining based on current throughput.

## Control Actions

*   **Pause**: Stops sending new batches to Odoo. Currently active batches will finish.
*   **Resume**: Continues the import from where it was paused.
*   **Abort**: Stops the import completely. Progress is saved, allowing you to resume later if you don't clear the session.

## Auto-Navigation to Results

When the import completes (all files processed) or is aborted, the Run view automatically navigates to the **Results** view, where you can review successes, failures, and export error logs.

## Handling Failures

Failures are handled based on your **Run Settings**:
*   **Automatic Retries**: If a row fails due to a transient error (e.g., network timeout or a lock wait), the tool will automatically retry it up to the configured limit.
*   **Fatal Errors**: If Odoo returns a non-retryable error (e.g., a constraint violation), the row is marked as failed. If "Stop on Fatal Error" is enabled, the entire import will halt.
*   **Standalone Mode**: In standalone mode, failed batches are automatically split using geometric retry (e.g., 100 → 10 → 1) to isolate individual failing rows. The batch size also adapts dynamically — growing after successes and shrinking after failures. See [Standalone Mode](../standalone-mode.md) for details.
