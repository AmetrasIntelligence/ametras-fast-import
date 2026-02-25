# Testing Strategy

The project maintains high code quality through a comprehensive test suite covering both the TypeScript client and the Python backend.

## 1. Unit Tests (Vitest)

Most of the client's logic is covered by Vitest unit tests. These are located in `tests/unit/`.

*   **Coverage**: The suite includes 514 tests.
*   **Key Test Areas**:
    *   `csvParser.test.ts`: Delimiter detection, streaming, and chunking.
    *   `stateMachine.test.ts`: Transitions between import states and error recovery.
    *   `smartMapping.test.ts`: Scoring logic for model and field suggestions.
    *   `batchExecutor.test.ts`: Parallel batch processing and worker coordination.
*   **Running Unit Tests**:
    ```bash
    npm test                # single run
    npm run test:watch      # re-run on file changes
    npm run test:coverage   # single run with coverage report
    ```

## 2. E2E Tests (Playwright)

End-to-end tests verify the entire application flow in a real Electron environment. They are located in `tests/e2e/`.

*   **Scenarios**:
    *   Login flow with server validation.
    *   File drag-and-drop and analysis.
    *   Full import process from configuration to result export.
    *   Navigation and persistence of settings.
*   **Running E2E Tests**:
    ```bash
    npm run test:e2e        # headless
    npm run test:e2e:ui     # interactive UI
    ```
*   **Running All Tests** (unit + e2e):
    ```bash
    npm run test:all
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

*   **Linting** (ESLint):
    ```bash
    npm run lint
    npm run lint:fix   # auto-fix
    ```
*   **Type Checking** (vue-tsc):
    ```bash
    npm run typecheck
    ```

## 5. Continuous Integration

Every pull request is automatically tested against:
1.  **Linter**: `npm run lint`.
2.  **Type Check**: `npm run typecheck`.
3.  **Unit Tests**: `npm test`.
4.  **Build Check**: `npm run build`.
