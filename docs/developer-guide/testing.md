# Testing Strategy

The project maintains high code quality through a comprehensive test suite covering both the TypeScript frontend and the Python backend.

## 1. Unit Tests (Vitest)

Unit tests for the shared Vue source are located in `ametras_fast_import_addon/vue-app/tests/unit/`.

*   **Coverage**: The suite includes 561 tests.
*   **Key Test Areas**:
    *   `csvParser.test.ts`: Delimiter detection, streaming, and chunking.
    *   `stateMachine.test.ts`: Transitions between import states and error recovery.
    *   `smartMapping.test.ts`: Scoring logic for model and field suggestions.
    *   `batchExecutor.test.ts`: Parallel batch processing and worker coordination.
    *   `errors.test.ts`: Error codes, severity mapping, category mapping, `classifyFetchError`, `isNetworkError`, `isNetworkErrorCode`.
    *   `connectionMonitor.test.ts`: Health check polling, exponential backoff, status transitions, `waitForConnection`, abort signal handling, destroy cleanup.
    *   `networkBatchError.test.ts`: `NetworkBatchError` class behavior, instanceof checks, rows preservation.
    *   `indicesToRanges.test.ts`: Range compaction utility for processed row tracking.
    *   `odooClient.test.ts`: Log lifecycle API functions (`createImportLog`, `updateImportLog`, `finalizeImportLog`, `getImportLog`), embedded mode guards.
*   **Running Unit Tests**:
    ```bash
    cd ametras_fast_import_addon/vue-app
    npm run test:unit        # single run (561 tests)
    npm run test:watch       # re-run on file changes
    npm run test:coverage    # single run with coverage report
    ```

## 2. E2E Tests (Playwright)

End-to-end tests verify the Electron client application flow. They are located in `ametras_fast_import_client/tests/e2e/`.

*   **Scenarios**:
    *   Login flow with server validation.
    *   File drag-and-drop and analysis.
    *   Full import process from configuration to result export.
    *   Navigation and persistence of settings.
*   **Running E2E Tests**:
    ```bash
    cd ametras_fast_import_client
    npm run test:e2e        # headless
    npm run test:e2e:ui     # interactive UI
    ```

## 3. Python Tests (Odoo)

Backend tests are written using Odoo's `TransactionCase` and focus on the `CSVImportController` logic.

*   **Key Areas**:
    *   Reference prefetching and resolution.
    *   Upsert logic (External ID vs. Natural Key).
    *   Savepoint isolation and error reporting.
*   **Running Python Tests**:
    ```bash
    /path/to/odoo-bin -c your_config.conf -i ametras_fast_import_addon --test-enable
    ```

## 4. Static Analysis

*   **Linting** (ESLint 10, flat config):
    ```bash
    cd ametras_fast_import_addon/vue-app && npm run lint
    cd ametras_fast_import_client && npm run lint
    ```
    Both packages use ESLint 10 flat config (`eslint.config.js`) with `typescript-eslint` and `eslint-plugin-vue`. Auto-fix is available via `npm run lint:fix`.

*   **Type Checking** (vue-tsc):
    ```bash
    cd ametras_fast_import_addon/vue-app && npm run typecheck
    cd ametras_fast_import_client && npm run typecheck
    ```

## 5. Continuous Integration

Every push and pull request on the `16.0` branch is automatically tested:
1.  **Lint**: `npm run lint` in both packages.
2.  **Type Check**: Both packages typechecked.
3.  **Unit Tests**: `npm run test:unit` in vue-app.
4.  **Build Check**: Both packages built (client builds on macOS, Windows, Linux).
