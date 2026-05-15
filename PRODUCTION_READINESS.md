# Production Readiness Plan — `csv-client`

> Branch: `python-refactor` (11 commits ahead of `origin/16.0`, 0 behind).
> Scope: close the refactoring gap left when the TypeScript import engine was deleted in favor of the Python engine (`models/import_engine/`), and harden what remains to production grade.

Each task lists **Why**, **Where** (file references with line numbers where useful), **Acceptance**, **Tests**, and a rough **Effort** estimate (S = ≤ ½ day, M = 1–3 days, L = ≥ 1 week).

Priorities follow blast-radius: **P0 = data integrity at risk**, **P1 = reliability / UX regressions vs 16.0**, **P2 = cleanup of orphaned code so future contributors don't trip**, **P3 = new work to reach production-grade observability and resilience**.

---

## P0 — Data integrity (must ship before any user does heavy imports)

### P0.1 — Restore the timeout-resilience pipeline (shrink → wait → retry, with idempotency as the last-line guard)

> **Scope confirmed.** Standalone (RPC) only. Embedded mode goes through per-row savepoints in `OrmBackend` and is already idempotent at the row level — retrying a savepoint that was rolled back never creates a duplicate. Standalone goes through XML-RPC where each `models.execute_kw` is its own transaction; a `create` that committed but whose response was dropped on the wire **will** duplicate on naive retry. This is where the 16.0 guard lived and where it needs to come back.

- **Why.** The user's recollection is correct: 16.0's behaviour was **not** "refuse to retry unless every row has a key". It was a soft, multi-stage degradation. Idempotency assessment was the *last* line of defence, only consulted when the adapter was already at minimum batch size and the timeout retry budget was nearly spent. The primary mechanism was **shrink + back off + retry**.

  Verified flow from `git show origin/16.0:ametras_fast_import_addon/vue-app/src/importer/engine.ts` (`executeBatchWithMapping`, lines ~520-770):

  1. `TimeoutBatchError` caught.
  2. `timeoutEscalationLevel` incremented (max `6` in standalone, `2` in addon).
  3. `BatchSizeAdapter.recordTimeout(...)` called → step down by one level immediately.
     - In standalone mode, also raise the success-threshold-for-ramp-up to `STANDALONE_POST_TIMEOUT_SUCCESS_THRESHOLD = 300` rows so the adapter ramps back up cautiously.
  4. **In standalone mode only**, call `assessTimeoutRetryIdempotency(batch.rows, mapping.fieldMappings)`.
     - All rows safe (have non-empty `id` or `.id`) → continue to retry the whole batch at the new smaller size.
     - Mixed → retry only the safe rows; fail unsafe rows with a clear "missing `id`/`.id`, safe retry skipped to avoid duplicates" message.
     - No safe rows at all → fail the whole batch with the duplicate-prevention message.
  5. If the adapter **did** step down → `continue` the retry loop with the smaller batch.
  6. If the adapter is already at minimum (`isAtMinimum`) → increment `timeoutsAtMinimum`, check `timeoutRetryBudgetMs` (`30 min` standalone / `10 min` addon), compute next delay `base * 2^(attempt-1) * (escalationLevel+1)` capped at `30 s`, `await waitTimeoutRetryDelay(...)`, then `continue`.
  7. If budget exhausted → fail the batch with a clear "timed out after Ns at minimum batch size" message.

  The user-facing outcome is: a flaky network or an oversized batch produces visible **shrinking and waiting**, not row failures. Only when the system has done everything reasonable does it surface failures, and only then does idempotency matter — and only for the rows where retry could create a duplicate.

- **Where to put the new code.**
  - `models/import_engine/backend.py` — `RpcBackend._call` currently does 3 quick retries (`2/4/6 s`) + 300 s reconnect wait + 1 final attempt at the **same** batch size. It doesn't know about batch size at all; the caller does.
  - `models/import_engine/importer.py` — the batch loop is the right place to host shrink-on-timeout because it owns the iteration over chunks.
  - New: `models/import_engine/batch_size_adapter.py` — port `BatchSizeAdapter` (see P1.1).
  - New: `models/import_engine/idempotency.py` — port `assessTimeoutRetryIdempotency` per-row safety check; used **only** when the standalone caller has shrunk to minimum and is about to retry without further shrinks.
  - Wire-up: when `Importer` is constructed with `backend=RpcBackend(...)` (standalone), enable the idempotency-aware retry path. When `backend=OrmBackend(...)` (embedded), skip the idempotency check entirely — savepoints handle it.

- **Acceptance.**
  - Standalone import with a flaky connection (artificial 5 s timeout every 3rd RPC) completes successfully on a CSV where every row has `id` mapped, with no duplicates.
  - Same test with `id`/`.id` removed from the mapping: rows still succeed as long as shrink-and-retry recovers within budget; the idempotency guard only fires when at minimum batch size *and* the retry would risk a duplicate.
  - Standalone import with a permanent timeout and no key column: batch eventually fails after the retry budget with a clear, actionable message — never silently double-creates.
  - Embedded import with the same flaky-timeout simulation: succeeds via savepoint replay; no idempotency code path is invoked.

- **Tests.** Port the *scenarios* (not the TS code) from 16.0's `idempotency.test.ts` + `engineNetworkResilience.test.ts` to Python:
  - `test_idempotency.py`:
    - Both `id` and `.id` mapped, all rows have non-empty values → all classified safe.
    - Only `.id` mapped, all rows have valid `.id` → all safe.
    - Mixed: some rows have `id`, some have only `.id`, some have neither → split correctly, reason counts (`empty_external_and_database_id`, `missing_key_mapping`, etc.) match expectations.
    - No key mapping at all → all rows unsafe with `missing_key_mapping`.
  - `test_backend_retry.py`:
    - Simulate "committed-but-response-lost" by mocking `models.execute_kw` to return `[1, 2, 3]` once, then raise `ProtocolError` on the next call. Verify the *Importer* (not the backend) is what decides whether to retry, and decides correctly based on idempotency.
    - Verify the retry waits the computed backoff, that the wait is interruptible by a `cancel` signal.
    - Verify the retry budget terminates the loop with a clear error after `STANDALONE_TIMEOUT_RETRY_BUDGET_MS` (30 min).
  - `test_importer_timeout_pipeline.py` — end-to-end on a fake `Backend` that raises `socket.timeout` deterministically:
    - 1st timeout → adapter steps down, batch retried at smaller size, succeeds → no row failures.
    - Repeated timeouts at minimum → exponential delay observed, budget enforced.
- **Effort.** M (~3 days including porting both modules and the test suite).

### P0.2 — Align the `workers` UI with reality: sequential batches in embedded, parallel in standalone

> **Decision: keep it simple.** Embedded mode runs batches sequentially. The `workers` setting only applies to standalone mode, where parallel batches already work correctly via Python `ThreadPoolExecutor` inside the `import_engine` subprocess (no cursor problem — standalone never touches an Odoo cursor, only RPC). The misleading `workers` knob in embedded mode is hidden, and any embedded profile with `workers > 1` is normalised to `1` server-side. Server-side threading in embedded mode is **deferred indefinitely**.

- **Why.** `ImportSettings.vue` exposes a "workers (1–4)" input and persists it in profiles, but [`import_job.py:141`](ametras_fast_import_addon/models/import_job.py:141) iterates batches sequentially regardless of the setting. The UI suggests a feature that doesn't exist. Either hide the knob or wire it through — and wiring it through in embedded mode requires non-trivial cursor work (HTTP fan-out OR thread-pool with manually managed `registry(db).cursor()` cycles). The user's call: not worth the engineering complexity at this stage.
- **What stays working** (sanity check — none of this changes):
  - Batch chunking (`for i in range(0, len(rows), batch_size)`) ✓
  - Per-row savepoint isolation in `OrmBackend` ✓
  - Adaptive batch sizing after P1.1 ✓
  - Timeout shrink + wait + retry after P0.1 ✓ (standalone only — embedded uses savepoints)
  - Row-level retry up to `retryLimit` ✓
  - Periodic progress commits every `PROGRESS_COMMIT_INTERVAL` ✓
  - Pause / Resume / Skip / Abort checked between batches ✓
- **Where.**
  - UI to hide: [`vue-app/src/components/ImportSettings.vue:73-86`](ametras_fast_import_addon/vue-app/src/components/ImportSettings.vue:73)
  - Default to keep but only honour in standalone: [`vue-app/src/stores/config.ts:36`](ametras_fast_import_addon/vue-app/src/stores/config.ts:36)
  - Server-side normaliser: [`models/import_job.py:65`](ametras_fast_import_addon/models/import_job.py:65) where settings are read
  - Standalone path (already correct — leave alone): [`models/import_engine/importer.py:179-260`](ametras_fast_import_addon/models/import_engine/importer.py:179), [`__main__.py:103`](ametras_fast_import_addon/models/import_engine/__main__.py:103)
- **Acceptance.**
  - The `workers` field in `ImportSettings.vue` is hidden when `platform.isEmbedded === true` and visible otherwise. Hidden, not disabled — a disabled field with a value invites the same confusion.
  - When a saved profile with `workers > 1` is loaded into embedded mode, the value is silently normalised to `1` for the running session (the profile on disk is left alone so the same profile still works in standalone).
  - `ImportJob.run` ignores the `workers` setting; no code path in `import_job.py` reads it. Add a comment explaining the deliberate ignore.
  - README updated (both languages) to clarify: workers configuration affects standalone mode only.
- **Why we're not wiring it through.** For completeness — to inform a future decision:
  - **Option B (HTTP fan-out)** mirrors 16.0's process-isolation pattern but adds an auth-forging path (capture session cookie at job-start, send `Cookie: session_id=…` on outbound POSTs), a new controller endpoint, and a deployment caveat (`workers ≤ odoo_workers - 1` to avoid starving the HTTP pool). ~5 days of work.
  - **Option C (registry-cursor threading)** uses Odoo's idiomatic `ThreadPoolExecutor` + `registry(db).cursor()` pattern. Less external surface, but we own the cursor lifecycle and every error path must roll back / close cleanly.
  - **Option D (parse-parallel / write-serial)** parallelises CSV parsing and reference resolution but funnels writes through one cursor; small speedup, fragile RO/RW env discipline.
  - All three add complexity that's currently not justified by the wallclock win — in ORM mode, parallel batches typically give 1.5–2.5× speedup at `workers=4`, not 4×, because writes serialise on DB locks and `_compute` recomputation. For a 20-minute import that's 8–12 minutes saved. Real, but not worth shipping a new failure surface for. Revisit after the bigger reliability work (P0.1, P1.1, P1.x) is in production and we have data on whether embedded throughput is actually a bottleneck.
- **Tests.**
  - `ImportSettings.test.ts`: workers field is not rendered when `platform.isEmbedded === true`.
  - `import_job.test.py`: passing `settings={'workers': 4}` to an embedded `ImportJob.run` produces the same results, in the same order, in roughly the same wallclock time as `settings={'workers': 1}` (the setting is a no-op).
  - Profile load: loading a `workers=4` profile into embedded mode reports `workers=1` in the active session config.
- **Effort.** S (~ ½ day). Mostly UI + a server-side normaliser.

---

## P1 — Reliability and UX regressions (silently worse than 16.0)

### P1.1 — Restore adaptive batch sizing on timeout (with row-scaled thresholds)

- **Why.** 16.0's `BatchSizeAdapter` stepped batch size down on timeout, back up after **30 consecutive successful rows**, with a step-down after 3 consecutive batch failures. On a flaky network or heavy model, this kept the import making forward progress where today it just retries the same large batch 3× and fails the whole chunk. With the default `batchSize: 200`, one timeout = 200 rows lost to the failed-batch retry path.
- **Where.**
  - 16.0 reference: `git show origin/16.0:ametras_fast_import_addon/vue-app/src/importer/batchSizeAdapter.ts`
  - Today's no-op: same fixed `batch_size` is used through every loop in [`import_job.py:141`](ametras_fast_import_addon/models/import_job.py:141) and [`importer.py:179-260`](ametras_fast_import_addon/models/import_engine/importer.py:179)
- **Threshold semantics.** Confirmed against the TS source: thresholds count **rows, not batches** — `recordSuccess(rowCount)` adds to a running counter and the step-up triggers at `successfulRows >= SUCCESS_THRESHOLD`. This is the row-scaled behaviour the user asked for: at `batchSize: 200` one successful batch immediately satisfies the 30-row threshold and ramps up; at `batchSize: 10` it takes three successful batches. Levels are `[1, min(10, max), max]` — three rungs, deduplicated and sorted, starting at the middle. Constants exposed:
  - `SUCCESS_THRESHOLD = 30` (rows)
  - `FAILURE_THRESHOLD = 3` (consecutive batch failures)
  - `STANDALONE_POST_TIMEOUT_SUCCESS_THRESHOLD = 300` (rows — a 10× elevated threshold after a timeout, optionally passed to `recordTimeout()`)

  **Note for the implementation port**: keep the row-not-batch counting. If batch sizes vary wildly (e.g. 10, 200, 1000) the row-based threshold gives smooth scaling automatically; a batch-count threshold would not.
- **Acceptance.** Adaptive shrinking lives in **one** place — `models/import_engine/batch_size_adapter.py` — so both embedded and standalone benefit. Constants exposed in `constants.py`. On `socket.timeout`/`xmlrpc.client.ProtocolError`, step down once and retry within the timeout-retry budget defined in P0.1 instead of failing the whole batch. The adapter survives across files within a single run (intentionally — it carries learned batch size to the next file for faster startup); reset between runs.
- **Tests.** Port the test cases from `16.0 batchSizeAdapter.test.ts` to a Python `test_batch_size_adapter.py`:
  - Levels build correctly for various `maxSize` (1, 10, 50, 200, 1000) — no duplicates, sorted.
  - Starts at middle level (index 1, or 0 if `maxSize <= 1`).
  - 30 successful rows → step up; 31st row at max level → still at max.
  - `recordSuccess(50)` with threshold 30 → step up after first call (overshoot is fine).
  - 3 consecutive failures → step down; 4th failure → step down again until floor.
  - At floor (`level 0`), `recordFailure` does not negative-index.
  - `recordTimeout()` immediately steps down regardless of failure count; resets both counters.
  - `recordTimeout()` at level 0 returns `False` (no further shrink possible).
  - `recordTimeout(success_threshold_after_timeout=300)` raises the threshold for the next ramp-up; a subsequent `recordSuccess` of 30 rows does **not** step back up until 300 successful rows are accumulated.
  - `recordSuccess` resets `consecutive_failures` to 0.
  - `isAtMinimum` reflects level 0 correctly.
- **Effort.** M

### P1.2 — Page-refresh double-start prevention

- **Why.** If a user refreshes the tab while an import is running, the in-memory Pinia state (`logId`, `state`) is lost. `RunView.onMounted` then calls `startImport()` which kicks off a **new** server log over the still-running one. Same job is now reported by two `csv_import_log` records and Odoo workers compete for the same attachments. No test, no guard.
- **Where.**
  - Mount path: [`vue-app/src/views/RunView.vue`](ametras_fast_import_addon/vue-app/src/views/RunView.vue) `onMounted` → `startImport()`
  - Server lookup that already exists: `csv_import_log.action_open_log()` and the `resume_log_id` mechanism
- **Acceptance.**
  - `RunView.onMounted` queries the server (via a new lightweight `/ametras_fast_import/import/active` endpoint) for any log owned by the current user with `job_state in ('running', 'paused')`. If found, attach to it: set `run.logId`, call `run.updateFromServer(...)`, do not call `startImport`.
  - If multiple active logs exist for the same user — that's an existing bug; surface a chooser, don't pick one silently.
- **Tests.**
  - Unit (run store): a new `attachToServerLog(log_id)` reducer that populates state from a server payload, distinguishable from `initRun` by leaving the existing run flow intact.
  - Integration: mount `RunView` with a mocked `window.api.odoo.call` returning an active log — assert `start` is NOT called and `run.logId` is set.
- **Effort.** M

### P1.3 — Mid-import stall detection beyond the startup watchdog

- **Why.** The 90 s watchdog (`RunView.vue:233-252`) clears itself after the **first** progress tick. A job that processes row 1 and then hangs is invisible to the frontend until the user clicks away. The server writes a `heartbeat` field on each commit ([`import_job.py:401`](ametras_fast_import_addon/models/import_job.py:401)), but the frontend never reads it.
- **Where.**
  - Watchdog: [`vue-app/src/views/RunView.vue:233-252`](ametras_fast_import_addon/vue-app/src/views/RunView.vue:233)
  - Heartbeat write: [`import_job.py:401`](ametras_fast_import_addon/models/import_job.py:401)
  - Polling: `pollProgress()` in the same view
- **Acceptance.**
  - Server progress endpoint returns `heartbeat` (ISO timestamp) in addition to the existing payload.
  - Frontend tracks last-seen heartbeat. If `now - heartbeat > stallThresholdMs` AND `connectionStatus !== 'offline'`, render a "Import may be stalled" warning with a "Force abort" option. Don't auto-abort.
  - **Threshold scales with batch size**, mirroring P1.1's row-scaled behaviour. A 200-row batch can legitimately take longer than a 10-row batch; a flat threshold would false-positive on large batches and false-negative on small ones. Suggested formula: `stallThresholdMs = max(90_000, batchSize * PER_ROW_MS + BASE_MS)` where `PER_ROW_MS ≈ 300` and `BASE_MS ≈ 30_000` — this is the same shape as 16.0's per-batch timeout (`IMPORT_TIMEOUT_BASE_MS + IMPORT_TIMEOUT_PER_ROW_MS * N`, clamped). Tune in soak testing.
  - The stall threshold also scales with `PROGRESS_COMMIT_INTERVAL` (currently 10 s) — the server's heartbeat is only as fresh as its last commit, so the floor must be at least `3 * PROGRESS_COMMIT_INTERVAL` to avoid spurious warnings.
- **Tests.** Port the *intent* of 16.0's stall scenarios. New tests in `run.test.ts`:
  - `updateFromServer` records `heartbeat`.
  - Computed `isStalled` flips after heartbeat-age exceeds threshold; flips back after a fresh tick.
  - `isStalled` is suppressed while `connectionStatus === 'offline'` (otherwise every disconnect looks like a stall).
  - Threshold computation: `stallThresholdMs(batchSize=10)` is much smaller than `stallThresholdMs(batchSize=1000)`; both have the documented `90 s` floor.
- **Effort.** S

### P1.4 — Abort/complete race in standalone (`runPythonImport`)

- **Why.** `runPythonImport()` is fired as a background async task (`importFn().catch(...)`). After the user clicks Abort, `controlImport('cancel')` sets `run.state = FAILED`, but the still-running `runPythonImport` can reach the end and call `run.setState(ImportState.COMPLETED)`, clobbering the FAILED state. Race window is short but real.
- **Where.** [`vue-app/src/views/RunView.vue`](ametras_fast_import_addon/vue-app/src/views/RunView.vue) — `runPythonImport`, `controlImport`, lines ~ 421-549, 555-582
- **Acceptance.**
  - Introduce a per-run cancellation token (e.g. an `AbortController` or a monotonic `runId`). The final `setState(COMPLETED)` must be guarded by `if (runId === currentRunId && !cancelled)`.
  - Bonus: `runPythonImport` runs inside a `try/finally` that calls `stopPolling()` regardless of outcome.
- **Tests.** A new `RunView.abort.test.ts`:
  - Abort during in-flight `window.api.python.import` → `state` stays FAILED, does not become COMPLETED.
  - Throw from `window.api.python.import` → `stopPolling()` has been called (poll timer null).
- **Effort.** S

### P1.5 — Connection-status feedback in embedded mode

- **Why.** 16.0's `ConnectionMonitor` ran an active health check (`POST /ametras_fast_import/info`) with exponential backoff and exposed a status listener API. Today's embedded mode only slows the poll interval on failure and flips `connectionStatus='offline'`. There's no "I'm trying to reconnect, please hold" UX, and `controlImport('resume')` issued during an offline window silently fails ([`RunView.vue:577`](ametras_fast_import_addon/vue-app/src/views/RunView.vue:577) catches and logs but does not surface).
- **Where.**
  - Server endpoint to repurpose: `/ametras_fast_import/info` (still present)
  - Current backoff: `pollProgress()` in `RunView.vue`
- **Acceptance.**
  - Surface a non-blocking banner "Server unreachable — retrying in N s" while `connectionStatus === 'offline'`.
  - Failing `controlImport` calls during offline are queued and re-attempted once status returns to `online`, OR the button is visibly disabled until reconnect. Either pattern is fine; the silent swallow is not.
- **Tests.** `RunView.control.test.ts`: `controlImport('resume')` with `window.api.odoo.call.mockResolvedValue({ ok: false })` results in either a visible error or a queued retry — assert exactly which one we pick.
- **Effort.** S

### P1.6 — Skip-while-paused has confusing latency

- **Why.** Server-side, `_wait_if_paused()` only breaks on `CANCEL`; a `SKIP` issued while paused stays buffered until the user resumes, at which point the file is then skipped. UX-wise the user clicks "Skip" and nothing visibly happens.
- **Where.** [`csv_import_log.py` → `_wait_if_paused`](ametras_fast_import_addon/models/csv_import_log.py:265-ish) (verify line)
- **Acceptance.** `_wait_if_paused()` also breaks on a pending `SKIP` signal AND auto-clears `job_pause_requested` when consuming the skip so the worker proceeds. Document the semantics in the controller docstring.
- **Tests.** Python test that posts pause → skip → asserts the file is skipped without an intervening resume call.
- **Effort.** S

---

## P2 — Cleanup of orphaned code (low risk, high signal-to-noise improvement)

### P2.1 — Delete unused `pythonExecutor.ts` or wire it in

- **Why.** `ametras_fast_import_client/src/standalone/pythonExecutor.ts` exports `executePythonBatch()` which is **never called**. Its `TimeoutBatchError` / `NetworkBatchError` / `AuthBatchError` classes have no consumer either. They throw `instanceof` checks that no caller catches.
- **Where.** [`src/standalone/pythonExecutor.ts`](ametras_fast_import_client/src/standalone/pythonExecutor.ts), [`src/standalone/types.ts`](ametras_fast_import_client/src/standalone/types.ts) `lines 44-70`
- **Acceptance.** Either delete `executePythonBatch` and the error classes (keeping only `isPythonAvailable` and `detectIdColumn`) OR wire `executePythonBatch` into the actual standalone import flow.
- **Tests.** Remove orphaned imports; type-check passes; e2e login still works.
- **Effort.** S

### P2.2 — Delete or wire `runStateLock`

- **Why.** Exported singleton with zero call sites. Dead code that *looks* live — invites bugs if someone wires it back without `try/finally`.
- **Where.** [`vue-app/src/utils/stateLock.ts:111`](ametras_fast_import_addon/vue-app/src/utils/stateLock.ts:111)
- **Acceptance.** Either:
  - Delete the singleton (keep the `StateLock` class if you think future callers will want it, or delete the whole file).
  - OR wire it around the critical sections in `RunView.vue` (`startImport`, `controlImport`, `runPythonImport`) where Pinia state could be mutated by both poll and user actions simultaneously.
- **Tests.** Tests added in this session (`tests/unit/stateLock.test.ts`) pin the contract — if you keep the class, the tests stay. If you delete it, delete them too.
- **Effort.** S

### P2.3 — Clean up stream mocks for the deleted CSV parser

- **Why.** `tests/setup.ts:21-39` still mocks `streamStart` / `streamNext` / `streamClose` for a frontend streaming parser that no longer exists. Confusing for new contributors.
- **Where.** [`vue-app/tests/setup.ts:21-39`](ametras_fast_import_addon/vue-app/tests/setup.ts:21) plus exported `setupMockStream` and `resetMockStreams` helpers
- **Acceptance.** Remove the helpers and the mocks. Verify nothing imports them (`grep -rn setupMockStream tests/`).
- **Effort.** S

### P2.4 — Remove `workers` defaults from profiles if P0.2 picks option (b)

- **Why.** If we hide the UI, the field still lives in saved-profile JSON and gets exported in profile zips. Stale defaults confuse profile-editor reviewers.
- **Where.** [`config.ts:36`](ametras_fast_import_addon/vue-app/src/stores/config.ts:36), [`profileApi.ts:78`](ametras_fast_import_addon/vue-app/src/api/profileApi.ts:78), profile export logic
- **Acceptance.** `workers` either disappears from `RunSettings` (with a migration that drops it from loaded profiles) or is renamed `standaloneWorkers` and only used by the standalone client.
- **Effort.** S

---

## P3 — Production-grade hardening (new work)

### P3.1 — Restore an integration test suite for resilience

- **Why.** 16.0 had `tests/integration/engineNetworkResilience.test.ts` (388 lines) and `importEngine.test.ts` (824 lines). They exercised retry, reconnect, pause/resume, idempotency, and resume-from-partial-log end-to-end against mocked `window.api.odoo.call`. Today there's no integration layer — only store-level unit tests and shallow Playwright presence checks.
- **Acceptance.** New `vue-app/tests/integration/runFlow.test.ts` that mounts `RunView` and:
  - Drives start → polling → batch progress → completion happy path.
  - Simulates a `pythonExecutor`-style timeout error → asserts adaptive shrink (after P1.1 lands).
  - Simulates network failure → polling slows → recovery → connection banner clears.
  - Pause → resume → resume preserves progress.
  - Abort while batch in flight → state ends in FAILED, no later COMPLETED.
  - Skip mid-file → next file picked up on next tick.
- **Tests to port from 16.0.** Don't re-import the deleted source; pick the **test scenarios** from the deleted spec files and reimplement them at the run-store / view layer:
  - From `engineNetworkResilience.test.ts`: connection-drop-then-recover, exhausted retries, timeout during retry, auth error mid-batch.
  - From `importEngine.test.ts`: resume from partial log, error-log dedup across polls, watchdog firing, file-level skip.
  - From `connectionMonitor.test.ts`: backoff schedule, multiple waiters resolved on reconnect.
- **Effort.** L

### P3.2 — Server-side test coverage for `ImportJob`

- **Why.** `import_job.py` is the new heart of the system. The Python test suite (`ametras_fast_import_addon/tests/`) covers `Importer` and `Resolver` heavily but barely touches `ImportJob`. The pause/resume/skip/abort control flow has no direct unit coverage.
- **Where.** [`ametras_fast_import_addon/tests/`](ametras_fast_import_addon/tests/) — already has `test_importer_comprehensive.py` and `test_resolver_integration.py`
- **Acceptance.** New `tests/test_import_job.py` covering:
  - Pause flag in the middle of a file → next batch waits → resume continues.
  - Skip flag mid-file → file marked skipped, next file starts.
  - Cancel flag mid-file → loop breaks, final_state = `interrupted`.
  - `_filter_pending_rows` resume scenarios: all-done, partial, with errors.
  - `_process_retries` exhausts `retryLimit` and surfaces remaining rows as failed.
  - `PROGRESS_COMMIT_INTERVAL` triggers a commit at the right time.
  - Stale-log cron picks up a job whose heartbeat is older than 2 h and resets state.
- **Effort.** M

### P3.3 — Observability: structured logs + error classification

- **Why.** Today's logs (`utils/logger.ts` frontend, Odoo `_logger` backend) write strings. We can't easily answer "how often does timeout happen during creates vs writes?" Without structured logging, the next time a customer reports "the import got stuck", the only forensics is "look at the screen and the Odoo log".
- **Acceptance.**
  - Frontend: extend `logger` so every batch outcome emits a single line with `{event, log_id, file, batch_start, batch_end, duration_ms, success, failed, retries, outcome}`.
  - Backend: same in `ImportJob` and `Importer`. Emit JSON via `_logger.info` so log aggregators can parse.
  - Add a `csv_import_log.diagnostics` JSON field (or just appended `error_log` entries) that records non-row events: timeouts, reconnect waits, idempotency skips, watchdog warnings.
- **Effort.** M

### P3.4 — Error UX: actionable failures in `ResultsView`

- **Why.** After an import, the user sees a raw list of error strings copied from Odoo. Many are inscrutable (`ValidationError: ('You cannot have two records with the same external ID', None)`). 16.0 had `utils/errors.ts` with classification — that's still there but not used to group/explain results.
- **Where.** [`ResultsView.vue`](ametras_fast_import_addon/vue-app/src/views/ResultsView.vue), [`utils/errors.ts`](ametras_fast_import_addon/vue-app/src/utils/errors.ts)
- **Acceptance.** Group errors by classification (`validation`, `permission`, `reference`, `network`, `unknown`), show a count + an expandable list per group, and link to a one-paragraph explanation per category. Add a "Copy failed rows as CSV" action that respects the user's original field order.
- **Effort.** M

### P3.5 — _(removed — explicit non-goal)_

Hard-blocking concurrent imports per user adds complexity without a clear payoff. The page-refresh / multi-tab risk is covered by **P1.2** (attach to the existing active log instead of starting a new one); that handles the realistic scenario. Cross-tab cooperation, multi-user concurrency, and stale-log cleanup are left to the existing `_cron_detect_stale_logs` backstop.

### P3.6 — Memory ceiling for `errors` in the run store

- **Why.** `errors.value` is an array that grows for the lifetime of the page. A 1 M-row import with 5 % failure rate puts 50 000 error objects in browser memory. The server caps its returned list at 100 but the frontend retains every error it has ever seen (errorKeys dedup set).
- **Where.** [`stores/run.ts:316-328`](ametras_fast_import_addon/vue-app/src/stores/run.ts:316)
- **Acceptance.** Cap `errors` at a configurable max (default 5 000). When the cap is hit, drop oldest and surface an indicator: "showing last 5 000 of 47 218 errors — download full list from the server log".
- **Effort.** S

### P3.7 — Accessibility + i18n audit on `RunView` and `ResultsView`

- **Why.** Long-running screens with progress bars, status messages, error tables and dynamic state changes are exactly where screen-reader UX falls apart. The `de.json` / `en.json` keys are not exhaustively covered — any new string from P1/P2 needs both.
- **Acceptance.**
  - `aria-live="polite"` on the progress region, `aria-live="assertive"` on connection-status and stall banners.
  - Every user-visible string in `RunView.vue` / `ResultsView.vue` flows through `t(...)`.
  - Run the existing `i18n` keys through a script that asserts both locales have the same keys and that no key references appear in source without a translation.
- **Effort.** S

---

## Tests to restore from 16.0 (mapped to new locations)

Even where the source unit is gone, the *scenarios* still represent real failure modes that the new architecture can hit. Port the **intent** of each, not the code:

| 16.0 test file | Scenario(s) worth keeping | Port to |
|---|---|---|
| `idempotency.test.ts` | Both keys mapped; only `.id`; missing values; no keys | Python `tests/test_backend_idempotency.py` (after P0.1) |
| `batchSizeAdapter.test.ts` | Step-up after threshold, step-down on failure, step-down on timeout, level-0 floor | Python `tests/test_batch_size_adapter.py` (after P1.1) |
| `connectionMonitor.test.ts` | Backoff schedule, multiple waiters, status flips | TS `tests/unit/connectionStatus.test.ts` testing whatever frontend logic replaces it (after P1.5) |
| `stateMachine.test.ts` | Allowed/forbidden transitions, terminal states | TS `tests/unit/stores/run.test.ts` — add explicit transition guard tests if a transition guard is reintroduced |
| `engineNetworkResilience.test.ts` | Disconnect → reconnect → resume; exhausted retries; auth mid-batch | TS `tests/integration/runFlow.test.ts` (after P3.1) |
| `importEngine.test.ts` | Resume from partial log; dedup across polls; watchdog; file skip | Split across `runFlow.test.ts` + `tests/test_import_job.py` (after P3.1 + P3.2) |
| `workerPool.test.ts` | Parallel batch submission, backpressure, no-result-loss under concurrency | Only relevant if P0.2 picks option (a) — then port to Python (`tests/test_importer_workers.py`) |
| `csvParser.test.ts` | Delimiter detection, encoding edge cases, malformed rows | Python `tests/test_parser_edge_cases.py` (already exists — review and ensure no edge case from the TS version is missed) |
| `networkBatchError.test.ts` | Error classification taxonomy | Drop if errors are no longer raised through this taxonomy; otherwise port to wherever the new taxonomy lives |
| `rowTransform.test.ts` | Field-mapping transforms (booleans, dates, m2o references) | Python `tests/test_transformer.py` already exists — diff against the deleted TS to ensure no mapping case dropped |

---

## Suggested sequencing

A four-milestone rollout that minimises in-flight risk. With Option A for P0.2, the workers question is now a quick UI fix and no longer entangled with P0.1 / P1.1.

1. **Milestone 1 — Stop the bleed (½ sprint).** **P0.2** (hide workers in embedded — quick win, removes user confusion), **P1.4** (abort race — small fix, prevents state corruption), **P2.3** (stream mocks cleanup). All low-risk, all small.
2. **Milestone 2 — Restore the resilience pipeline (2 sprints).** Coupled pair: **P1.1** (port `BatchSizeAdapter` to Python) and **P0.1** (idempotency-aware retry on top of the adapter). These two share the same data structures and test surface; ship them as one coordinated change. Restore the test scenarios listed under P3.1's "test-restoration" mapping as you build, not after.
3. **Milestone 3 — UX reliability (1 sprint).** **P1.2** (page-refresh attach), **P1.3** (stall detection), **P1.5** (connection feedback), **P1.6** (skip-while-paused), and remaining cleanup **P2.1**, **P2.2**, **P2.4**.
4. **Milestone 4 — Production-grade (1–2 sprints).** **P3.1** (integration suite — leverages everything above), **P3.2** (server-side `ImportJob` tests), **P3.3** (structured logs) in parallel; **P3.4** (error UX) and **P3.6** (errors memory cap) once observability lands; **P3.7** (a11y/i18n) as horizon work.

---

## Out of scope (explicit non-goals)

- **Rebuilding a frontend import engine.** The Python-first architecture is a strict simplification and that's good. Don't put the engine back in TS.
- **Multi-tenant / multi-user job scheduling.** The current "one run per user" model is fine for the target deployment scale. Don't add a queue.
- **Schema migrations of `csv_import_log`.** Any field additions in this plan should be additive; no rename, no drop.

---

## Decisions (resolved)

1. **Idempotency model (P0.1).** Soft fallback, not a hard upfront gate. Restore 16.0's flow: shrink → escalate → wait → retry, with `assessTimeoutRetryIdempotency` consulted only in standalone mode and only when the adapter is at minimum and would otherwise retry. Embedded mode does not need this layer because per-row savepoints already make ORM-mode retries idempotent.
2. **Workers (P0.2).** Embedded mode runs batches sequentially; the misleading UI knob is hidden. Standalone mode keeps its existing parallel-batches behaviour via Python `ThreadPoolExecutor` inside the `import_engine` subprocess (no Odoo cursor involved — only RPC calls). Embedded parallelism is **explicitly deferred** — revisit only after the bigger reliability work has produced real throughput data.
3. **Adaptive batch (P1.1).** Restored with row-scaled thresholds — `SUCCESS_THRESHOLD = 30` rows, not batches. The TS implementation already counted rows; preserve that semantic in the Python port so threshold behaviour scales naturally with `batchSize`.
4. **Stall threshold (P1.3).** Scales with batch size using the same `BASE + PER_ROW * N` shape as 16.0's per-batch timeout, with a 90 s floor and a `3 * PROGRESS_COMMIT_INTERVAL` floor on top of that.
5. **Concurrent imports.** No hard-block. P3.5 is dropped; **P1.2 (attach to existing active log)** handles the realistic page-refresh / multi-tab cases without adding lock state.

## Remaining open questions

- **`STANDALONE_POST_TIMEOUT_SUCCESS_THRESHOLD` value (P0.1).** 16.0 used a fixed `300` rows. Acceptable to start with the same constant; revisit if support data shows imports ramping up too fast (causing repeat timeouts) or too slow (wasting throughput).
- **When (or whether) to revisit embedded parallelism (P0.2).** Deferred for now. Trigger to reopen: real production data showing embedded-mode wallclock is consistently a complaint AND the resilience work in milestones 2–3 has settled. If we do revisit, the doc above lists three patterns (HTTP fan-out, registry-cursor threading, parse-parallel/write-serial) with their trade-offs.
