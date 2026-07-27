"""
Main import orchestrator.

Unifies the import code path for both addon mode (OrmBackend) and
Electron subprocess mode (RpcBackend). Handles:
- Row transformation (CSV columns -> Odoo fields)
- Reference resolution (external IDs -> database IDs)
- Upsert logic (create/update with multiple strategies)
- Per-row error isolation
- Parallel batch processing (ThreadPoolExecutor)
- Progress reporting
"""
from __future__ import annotations

import logging
import threading
import time as _time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace as dc_replace
from typing import Callable, Iterator

from .backend import FieldInfo, OdooBackend, TransportError
from .constants import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_IMPORT_MODULE,
    FIELD_EXTERNAL_ID,
    FIELD_ID,
    FIELD_OPERATION,
    MAX_WORKERS,
    MIN_WORKERS,
    MODEL_IR_MODEL_DATA,
    NOTICE_BATCH_SHRUNK,
    NOTICE_IMPORT_CONFIG,
    NOTICE_RETRY_BUDGET_EXHAUSTED,
    NOTICE_SAFE_RETRY_TIMED_OUT,
    NOTICE_UNSAFE_ROWS_SKIPPED,
    NOTICE_WAITING_FOR_RETRY,
    OP_CREATE,
    OP_SKIP,
    OP_UPDATE,
    STANDALONE_POST_TIMEOUT_SUCCESS_THRESHOLD,
    STANDALONE_TIMEOUT_RETRY_BUDGET_SECONDS,
    STRATEGY_CREATE,
    STRATEGY_DB_ID,
    STRATEGY_EXPLICIT_OP,
    STRATEGY_EXTERNAL_ID,
    STRATEGY_SEARCH_KEYS,
    TIMEOUT_RETRY_BASE_DELAY,
    TIMEOUT_RETRY_MAX_DELAY,
    VALID_OPERATIONS,
)
from .parser import (
    ParsedRow,
    ParseOptions,
    count_csv_rows,
    parse_csv_batched,
    parse_csv_file,
)
from .progress import NullReporter, ProgressReporter
from .resolver import prefetch_references, resolve_row
from .transformer import transform_row_data
from .validator import ValidationMismatch, ValidationReport, is_empty, values_match

_logger = logging.getLogger(__name__)


class _DryRunRollback(Exception):
    """Raised inside a savepoint to trigger rollback in dry-run mode."""


@dataclass
class ImportConfig:
    """Configuration for an import run."""

    model: str
    field_mappings: dict  # CSV column -> Odoo field
    use_external_id: bool = False
    search_keys: list[str] | None = None
    dry_run: bool = False
    strict: bool = False
    batch_size: int = DEFAULT_BATCH_SIZE


@dataclass
class RowResult:
    """Result of importing a single row."""

    ok: bool
    row_index: int
    error: str | None = None
    record_id: int | None = None
    external_id: str | None = None
    action: str | None = None  # 'created', 'updated', 'skipped'
    strategy: str | None = None
    dry_run: bool = False


@dataclass
class ImportFileSummary:
    """Result of a file-level import run.

    Replaces the previous list[RowResult] return from import_csv_file so that
    successes are never accumulated in memory — only the (typically small)
    failure set is kept.
    """

    success: int
    failed: int
    errors: list[RowResult]  # only failed rows
    file_error: str | None = None  # whole-file error (bad config, access denied)


class Importer:
    """
    Main import engine.

    Usage (addon mode):
        backend = OrmBackend(request.env)
        importer = Importer(backend, config)
        results = importer.import_rows(parsed_rows)

    Usage (subprocess mode):
        backend = RpcBackend.authenticate(url, db, login, password)
        importer = Importer(backend, config, reporter=JsonLinesReporter())
        summary = importer.import_csv_file('/path/to/file.csv', workers=4)
    """

    def __init__(
        self,
        backend: OdooBackend,
        config: ImportConfig,
        reporter: ProgressReporter | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ):
        self.backend = backend
        self.config = config
        self.reporter = reporter or NullReporter()
        self.cancel_check = cancel_check
        self._field_info_cache: dict[str, FieldInfo] | None = None
        self._cancelled = False

    def _get_field_info(self) -> dict[str, FieldInfo]:
        if self._field_info_cache is None:
            self._field_info_cache = self.backend.get_field_info(self.config.model)
        return self._field_info_cache

    def cancel(self) -> None:
        self._cancelled = True

    def _is_cancelled(self) -> bool:
        if self._cancelled:
            return True
        if self.cancel_check and self.cancel_check():
            self._cancelled = True
            return True
        return False

    # -------------------------------------------------------------------------
    # Public API
    # -------------------------------------------------------------------------

    def import_rows(self, rows: list[ParsedRow]) -> list[RowResult]:
        """
        Import a batch of parsed rows.

        This is the core method used by both modes. Thread-safe: each call
        creates its own ref_map and doesn't share mutable state.
        """
        field_info = self._get_field_info()

        # 1. Transform rows using field mappings. A transform error (e.g. a
        #    non-numeric .id) must fail only its own row, not abort the batch,
        #    so each row is transformed defensively.
        transformed: list[tuple[int, dict]] = []
        transform_errors: list[RowResult] = []
        for row in rows:
            try:
                if self.config.field_mappings:
                    mapped = transform_row_data(row.data, self.config.field_mappings)
                else:
                    mapped = dict(row.data)
            except Exception as e:  # isolate a bad row; never abort the batch
                err = RowResult(ok=False, row_index=row.index, error=str(e))
                transform_errors.append(err)
                self.reporter.row_completed(row.index, False, err.error or "")
                continue
            transformed.append((row.index, mapped))

        # 2. Prefetch all external ID references in batch
        raw_rows = [t[1] for t in transformed]
        try:
            ref_map = prefetch_references(
                self.backend, self.config.model, field_info, raw_rows
            )
        except ValueError as e:
            return transform_errors + [
                RowResult(ok=False, row_index=t[0], error=str(e)) for t in transformed
            ]

        # 3. Import row by row with savepoints
        results: list[RowResult] = []
        for row_index, row_data in transformed:
            result = self._import_single_row_safe(
                row_index, row_data, field_info, ref_map
            )
            results.append(result)
            self.reporter.row_completed(row_index, result.ok, result.error or "")

        # Transform-failed rows are part of this batch's results so callers
        # count them as failures (never silently dropped).
        return transform_errors + results

    def validate_rows(self, rows: list[ParsedRow]) -> ValidationReport:
        """Re-derive each row and check the DB stored what the import intended.

        Runs the *same* transform -> resolve -> record-lookup as the import, but
        performs no writes: it locates the record the row maps to (by external
        id / search key / .id) and compares the intended writable values against
        what is stored now. Rows with no stable key (pure creates) cannot be
        located afterwards and are reported as unvalidatable — never silently
        dropped. Read-only; safe to run any number of times after an import.
        """
        field_info = self._get_field_info()
        report = ValidationReport(model=self.config.model)

        transformed: list[tuple[int, dict]] = []
        for row in rows:
            try:
                if self.config.field_mappings:
                    mapped = transform_row_data(row.data, self.config.field_mappings)
                else:
                    mapped = dict(row.data)
            except Exception as e:  # noqa: BLE001 — report, never abort
                report.unvalidatable.append((row.index, f"transform error: {e}"))
                continue
            transformed.append((row.index, mapped))

        try:
            ref_map = prefetch_references(
                self.backend, self.config.model, field_info, [t[1] for t in transformed]
            )
        except ValueError as e:
            for row_index, _ in transformed:
                report.unvalidatable.append(
                    (row_index, f"reference prefetch failed: {e}")
                )
            return report

        # (row_index, record_id, intended_writable_vals)
        targets: list[tuple[int, int, dict]] = []
        for row_index, row_data in transformed:
            try:
                resolved, _warnings = resolve_row(
                    self.backend, self.config.model, field_info, row_data, ref_map
                )
            except Exception as e:  # noqa: BLE001 — a row that would have failed
                report.unvalidatable.append((row_index, f"resolve error: {e}"))
                continue

            row = dict(resolved)
            external_id = row.pop(FIELD_EXTERNAL_ID, None)
            db_id = row.pop(FIELD_ID, None)
            operation = row.pop(FIELD_OPERATION, None)

            if operation and operation.lower().strip() == OP_SKIP:
                continue  # nothing was written for a skipped row

            record_id, _strategy, _missing = self._resolve_record(
                row, external_id, db_id
            )
            if not record_id:
                report.unvalidatable.append(
                    (
                        row_index,
                        "no stable key (created without external id / search key "
                        "/ .id) — the imported record cannot be located",
                    )
                )
                continue

            intended = self._filter_writable(row, is_update=True)
            targets.append((row_index, record_id, intended))

        if not targets:
            return report

        # One batched read-back per model for all located records.
        ids = list({rec_id for _, rec_id, _ in targets})
        fields = sorted({name for _, _, vals in targets for name in vals})
        stored_records = self.backend.search_read(
            self.config.model, [("id", "in", ids)], fields
        )
        stored_by_id = {rec["id"]: rec for rec in stored_records}

        for row_index, record_id, intended in targets:
            report.checked += 1
            stored = stored_by_id.get(record_id)
            if stored is None:
                report.mismatches.append(
                    ValidationMismatch(
                        row_index, record_id, "id", record_id, None, "missing"
                    )
                )
                continue
            row_ok = True
            for name, intended_val in intended.items():
                info = field_info.get(name)
                ftype = info.type if info else "char"
                stored_val = stored.get(name)
                if not values_match(ftype, intended_val, stored_val):
                    kind = (
                        "dropped"
                        if is_empty(stored_val) and not is_empty(intended_val)
                        else "changed"
                    )
                    report.mismatches.append(
                        ValidationMismatch(
                            row_index, record_id, name, intended_val, stored_val, kind
                        )
                    )
                    row_ok = False
            if row_ok:
                report.ok += 1

        return report

    def import_pre_transformed_rows(self, rows: list[dict]) -> list[RowResult]:
        """Import rows already in Odoo field format (legacy API compatibility)."""
        parsed = [ParsedRow(index=i + 1, data=row) for i, row in enumerate(rows)]
        temp = Importer(
            self.backend,
            dc_replace(self.config, field_mappings={}),
            self.reporter,
            self.cancel_check,
        )
        return temp.import_rows(parsed)

    def import_csv_file(
        self,
        file_path: str,
        options: ParseOptions | None = None,
        workers: int = 1,
    ) -> ImportFileSummary:
        """
        Import from a local CSV file.

        Streams the file in batches — never loads all rows into memory.
        The sequential RPC path (workers=1) keeps at most one batch in memory
        at a time; on transport error it retries that batch without re-reading
        the file. The parallel path limits in-flight batches via a semaphore.

        Args:
            file_path: Path to CSV file
            options: CSV parsing options
            workers: Parallel workers (1-4). >1 overlaps network latency for RPC.

        Returns:
            ImportFileSummary with counts and only the failed RowResults.
        """
        import os

        opts = options or ParseOptions()
        workers = max(MIN_WORKERS, min(MAX_WORKERS, workers))

        total_rows = count_csv_rows(file_path, opts.encoding, opts.has_header)
        filename = os.path.basename(file_path)
        self.reporter.file_started(filename, total_rows)

        self.backend.check_access_rights(self.config.model, "create")
        self.backend.check_access_rights(self.config.model, "write")

        if self.config.search_keys:
            field_info = self._get_field_info()
            for key in self.config.search_keys:
                if key not in field_info:
                    error = f"Search key {key!r} not found on model {self.config.model}"
                    self.reporter.error(error)
                    return ImportFileSummary(
                        success=0, failed=0, errors=[], file_error=error
                    )

        all_errors: list[RowResult] = []
        success = 0
        failed = 0

        from .backend import RpcBackend  # local import avoids circular dependency

        is_rpc = isinstance(self.backend, RpcBackend)

        # Announce the effective run configuration (concurrency, batch size,
        # RPC timeout) so it's visible in the client console — these were
        # previously only knowable from server-side stderr.
        rpc_timeout = getattr(self.backend, "timeout", None) if is_rpc else None
        self.reporter.notice(
            NOTICE_IMPORT_CONFIG,
            "{fn}: {w} worker(s){par}, batch size {b}{to}.".format(
                fn=filename,
                w=workers,
                par=" (parallel)" if workers > 1 else " (sequential)",
                b=self.config.batch_size,
                to=", RPC timeout {}s".format(rpc_timeout) if rpc_timeout else "",
            ),
            workers=workers,
            batch_size=self.config.batch_size,
            parallel=workers > 1,
            rpc_timeout_seconds=rpc_timeout,
            total_rows=total_rows,
        )

        source = parse_csv_file(file_path, opts)

        if workers <= 1:
            if is_rpc:
                # Standalone: stream one batch at a time; retry logic keeps
                # only the current batch in memory, not the whole file.
                success, failed = self._import_sequential_with_retry(
                    self._iter_batches(source, self.config.batch_size),
                    all_errors,
                    total_rows,
                )
            else:
                # Embedded: stream via callback, accumulate only error rows
                def process_batch(batch: list[ParsedRow]) -> None:
                    nonlocal success, failed
                    if self._is_cancelled():
                        return
                    results = self.import_rows(batch)
                    errs = [r for r in results if not r.ok]
                    all_errors.extend(errs)
                    success += len(results) - len(errs)
                    failed += len(errs)
                    self.reporter.batch_completed(
                        success + failed, total_rows, success, failed, len(results)
                    )
                    self.reporter.emit_errors(
                        [{"row": r.row_index, "error": r.error} for r in errs]
                    )

                parse_csv_batched(source, self.config.batch_size, process_batch)
        else:
            # Parallel (RpcBackend): done callbacks process each batch's results
            # immediately so only error RowResults accumulate in all_errors — the
            # full result list is discarded inline rather than held until a second
            # sequential drain pass.  sem.release() is called inside the callback
            # (after results are consumed) so the semaphore bounds both raw data
            # and result objects in memory simultaneously.
            lock = threading.Lock()
            sem = threading.Semaphore(workers + 1)

            def _make_callback(row_indices: list[int]) -> Callable:
                def _on_done(future) -> None:
                    nonlocal success, failed
                    try:
                        batch_results = future.result()
                    except Exception as exc:
                        batch_results = [
                            RowResult(ok=False, row_index=idx, error=str(exc))
                            for idx in row_indices
                        ]
                    errs = [r for r in batch_results if not r.ok]
                    with lock:
                        success += len(batch_results) - len(errs)
                        failed += len(errs)
                        all_errors.extend(errs)
                    sem.release()  # slot freed only after results are consumed
                    self.reporter.batch_completed(
                        success + failed,
                        total_rows,
                        success,
                        failed,
                        len(batch_results),
                    )
                    self.reporter.emit_errors(
                        [{"row": r.row_index, "error": r.error} for r in errs]
                    )

                return _on_done

            with ThreadPoolExecutor(max_workers=workers) as executor:
                for batch in self._iter_batches(source, self.config.batch_size):
                    if self._is_cancelled():
                        break
                    sem.acquire()  # blocks until a callback has freed a slot
                    future = executor.submit(self.import_rows, batch)
                    future.add_done_callback(_make_callback([r.index for r in batch]))
                # executor.__exit__ calls shutdown(wait=True):
                # all pending callbacks complete before this block exits

        self.reporter.file_completed(filename, success, failed)

        if failed > 0:
            _logger.info(
                "%s: %d/%d rows imported, %d failed",
                filename,
                success,
                success + failed,
                failed,
            )
            seen_errors: set[str] = set()
            for r in all_errors:
                msg = r.error or ""
                key = msg[:80]
                if key not in seen_errors:
                    seen_errors.add(key)
                    _logger.info("  Row %d: %s", r.row_index, msg[:200])
                if len(seen_errors) >= 5:
                    remaining = len(all_errors) - 5
                    if remaining > 0:
                        _logger.info("  ... and %d more errors", remaining)
                    break
        else:
            _logger.info("%s: %d rows imported successfully", filename, success)

        return ImportFileSummary(success=success, failed=failed, errors=all_errors)

    # -------------------------------------------------------------------------
    # Helpers
    # -------------------------------------------------------------------------

    @staticmethod
    def _iter_batches(
        source: Iterator[ParsedRow],
        batch_size: int,
    ) -> Iterator[list[ParsedRow]]:
        """Yield successive fixed-size batches from a row iterator.

        Never pre-loads the full source — each batch is yielded as it is read,
        so memory is bounded to batch_size rows at a time.
        """
        batch: list[ParsedRow] = []
        for row in source:
            batch.append(row)
            if len(batch) >= batch_size:
                yield batch
                batch = []
        if batch:
            yield batch

    # -------------------------------------------------------------------------
    # Standalone resilience loop
    # -------------------------------------------------------------------------

    def _import_sequential_with_retry(
        self,
        batch_iter: Iterator[list[ParsedRow]],
        all_errors: list[RowResult],
        total_rows: int,
    ) -> tuple[int, int]:
        """
        Sequential batch loop for standalone (RPC) mode.

        Reads one batch at a time from batch_iter; on TransportError it
        shrinks the current batch via the adapter and retries without
        re-reading the file.  Only the current batch (≤ batch_size rows)
        is ever in memory.

        Returns (success_count, failed_count).

        On TransportError:
        1. Ask BatchSizeAdapter to step down.
        2. If stepped down → split current batch into smaller sub-batches,
           push them onto a local deque, retry without advancing the iterator.
        3. If already at minimum → check idempotency:
           - Unsafe rows (no id/.id) → fail immediately to avoid duplicates.
           - Safe rows → exponential backoff retry until budget exhausted.
        """
        from .batch_size_adapter import BatchSizeAdapter
        from .idempotency import assess_timeout_retry_idempotency

        adapter = BatchSizeAdapter(self.config.batch_size)
        budget_start = _time.monotonic()
        escalation_level = 0
        processed = 0
        success = 0
        failed = 0

        for raw_batch in batch_iter:
            # `pending` holds sub-batches derived from raw_batch.
            # Normally just [raw_batch]. On adapter step-down it becomes
            # multiple smaller slices — all still kept in memory but bounded
            # by the original batch_size.
            pending: deque[list[ParsedRow]] = deque([raw_batch])

            while pending:
                if self._is_cancelled():
                    return success, failed

                batch = pending.popleft()

                try:
                    results = self.import_rows(batch)
                    errs = [r for r in results if not r.ok]
                    all_errors.extend(errs)
                    success += len(results) - len(errs)
                    failed += len(errs)
                    processed += len(results)
                    adapter.record_success(len(batch))
                    self.reporter.batch_completed(
                        processed, total_rows, success, failed, len(results)
                    )
                    self.reporter.emit_errors(
                        [{"row": r.row_index, "error": r.error} for r in errs]
                    )

                except TransportError:
                    escalation_level += 1
                    success_threshold = STANDALONE_POST_TIMEOUT_SUCCESS_THRESHOLD
                    stepped_down = adapter.record_timeout(
                        success_threshold_after_timeout=success_threshold
                    )

                    if stepped_down:
                        _logger.warning(
                            "Batch timeout (level %d), shrinking to %d rows and retrying.",
                            escalation_level,
                            adapter.current_size,
                        )
                        self.reporter.notice(
                            NOTICE_BATCH_SHRUNK,
                            "Batch timed out — shrinking to {} rows and retrying.".format(
                                adapter.current_size
                            ),
                            level=escalation_level,
                            batch_size=adapter.current_size,
                            previous_batch_size=len(batch),
                        )
                        new_size = adapter.current_size
                        sub_batches = [
                            batch[i : i + new_size]
                            for i in range(0, len(batch), new_size)
                        ]
                        pending.extendleft(reversed(sub_batches))
                        continue

                    # Already at minimum batch size — assess idempotency
                    idm = assess_timeout_retry_idempotency(
                        batch, self.config.field_mappings
                    )

                    if idm.unsafe:
                        _logger.warning(
                            "%d rows lack id/.id mapping — failing to avoid duplicates "
                            "(reasons: %s).",
                            len(idm.unsafe),
                            idm.reason_counts,
                        )
                        self.reporter.notice(
                            NOTICE_UNSAFE_ROWS_SKIPPED,
                            "{} rows lack id/.id mapping — failing to avoid duplicates.".format(
                                len(idm.unsafe)
                            ),
                            count=len(idm.unsafe),
                            reason_counts=dict(idm.reason_counts),
                        )
                        for row in idm.unsafe:
                            all_errors.append(
                                RowResult(
                                    ok=False,
                                    row_index=row.index,
                                    error=(
                                        "missing id/.id: safe retry skipped to avoid "
                                        "duplicate records"
                                    ),
                                )
                            )
                        failed += len(idm.unsafe)
                        processed += len(idm.unsafe)
                        self.reporter.batch_completed(
                            processed, total_rows, success, failed, len(idm.unsafe)
                        )

                    pending_safe = list(idm.safe)
                    while pending_safe:
                        if self._is_cancelled():
                            return success, failed

                        elapsed = _time.monotonic() - budget_start
                        if elapsed >= STANDALONE_TIMEOUT_RETRY_BUDGET_SECONDS:
                            _logger.error(
                                "Timeout retry budget exhausted (%.0fs). "
                                "Failing %d remaining safe rows.",
                                elapsed,
                                len(pending_safe),
                            )
                            self.reporter.notice(
                                NOTICE_RETRY_BUDGET_EXHAUSTED,
                                "Timeout retry budget exhausted ({:.0f}s) — "
                                "failing {} remaining rows.".format(
                                    elapsed, len(pending_safe)
                                ),
                                elapsed_seconds=round(elapsed, 1),
                                failed_rows=len(pending_safe),
                            )
                            for row in pending_safe:
                                all_errors.append(
                                    RowResult(
                                        ok=False,
                                        row_index=row.index,
                                        error=(
                                            f"Timed out after {elapsed:.0f}s at minimum "
                                            f"batch size — retry budget exhausted"
                                        ),
                                    )
                                )
                            failed += len(pending_safe)
                            processed += len(pending_safe)
                            pending_safe = []
                            break

                        delay = min(
                            TIMEOUT_RETRY_BASE_DELAY
                            * (2 ** max(0, escalation_level - 1))
                            * escalation_level,
                            TIMEOUT_RETRY_MAX_DELAY,
                        )
                        _logger.info(
                            "At minimum batch size with %d safe rows. "
                            "Waiting %.1fs (attempt %d).",
                            len(pending_safe),
                            delay,
                            escalation_level,
                        )
                        self.reporter.notice(
                            NOTICE_WAITING_FOR_RETRY,
                            "At minimum batch size with {} safe rows — "
                            "waiting {:.1f}s before retry (attempt {}).".format(
                                len(pending_safe), delay, escalation_level
                            ),
                            safe_rows=len(pending_safe),
                            delay_seconds=round(delay, 1),
                            attempt=escalation_level,
                        )
                        sleep_start = _time.monotonic()
                        while _time.monotonic() - sleep_start < delay:
                            if self._is_cancelled():
                                return success, failed
                            _time.sleep(min(0.5, delay))

                        try:
                            safe_results = self.import_rows(pending_safe)
                            safe_errs = [r for r in safe_results if not r.ok]
                            all_errors.extend(safe_errs)
                            success += len(safe_results) - len(safe_errs)
                            failed += len(safe_errs)
                            processed += len(safe_results)
                            adapter.record_success(len(pending_safe))
                            self.reporter.batch_completed(
                                processed,
                                total_rows,
                                success,
                                failed,
                                len(safe_results),
                            )
                            self.reporter.emit_errors(
                                [
                                    {"row": r.row_index, "error": r.error}
                                    for r in safe_errs
                                ]
                            )
                            pending_safe = []
                        except TransportError:
                            escalation_level += 1
                            _logger.warning(
                                "Retry of %d safe rows also timed out (attempt %d).",
                                len(pending_safe),
                                escalation_level,
                            )
                            self.reporter.notice(
                                NOTICE_SAFE_RETRY_TIMED_OUT,
                                "Retry of {} safe rows also timed out (attempt {}).".format(
                                    len(pending_safe), escalation_level
                                ),
                                safe_rows=len(pending_safe),
                                attempt=escalation_level,
                            )

        return success, failed

    # -------------------------------------------------------------------------
    # Row-level import logic
    # -------------------------------------------------------------------------

    def _import_single_row_safe(
        self,
        row_index: int,
        row_data: dict,
        field_info: dict[str, FieldInfo],
        ref_map: dict,
    ) -> RowResult:
        """Import a single row with savepoint isolation."""
        result: RowResult | None = None
        try:
            with self.backend.savepoint():
                self.backend.flush_all()
                resolved, _warnings = resolve_row(
                    self.backend, self.config.model, field_info, row_data, ref_map
                )
                result = self._import_row(resolved)
                result.row_index = row_index
                self.backend.flush_all()
                if self.config.dry_run:
                    raise _DryRunRollback()
                return result

        except _DryRunRollback:
            result.dry_run = True  # type: ignore[union-attr]
            return result  # type: ignore[return-value]
        except TransportError:
            raise
        except Exception as e:
            error_msg = str(e)
            _logger.debug(
                "Row %d failed (%s): %s", row_index, self.config.model, error_msg
            )
            return RowResult(ok=False, row_index=row_index, error=error_msg)

    def _filter_writable(self, row: dict, is_update: bool) -> dict:
        """Strip fields that must not be written.

        - readonly + non-stored (computed without inverse): always removed.
        - readonly + stored: allowed on update, stripped on create.
        """
        field_info = self._get_field_info()
        result = {}
        for key, val in row.items():
            info = field_info.get(key)
            if info is not None and info.readonly:
                if not info.store:
                    continue  # computed non-stored: can never be written
                if not is_update:
                    continue  # readonly stored: skip on create (updates only)
            result[key] = val
        return result

    def _import_row(self, row: dict) -> RowResult:
        """
        Import single row with deterministic upsert logic.

        Decision tree:
        1. Has __op__? → Explicit operation (create/update/skip)
        2. Has __external_id__ and use_external_id? → External ID strategy
        3. Has search_keys and all keys present? → Natural Key strategy
        4. Else → Create (or fail if strict mode)
        """
        row = dict(row)  # Copy to avoid mutation
        external_id = row.pop(FIELD_EXTERNAL_ID, None)
        db_id = row.pop(FIELD_ID, None)
        operation = row.pop(FIELD_OPERATION, None)

        if operation:
            return self._handle_explicit_operation(row, operation, external_id, db_id)

        record_id, strategy_used, missing_keys = self._resolve_record(
            row, external_id, db_id
        )

        if not record_id and self.config.strict and missing_keys:
            return RowResult(
                ok=False,
                row_index=0,
                error=f"Missing search keys: {', '.join(missing_keys)}",
            )

        if record_id:
            write_row = self._filter_writable(row, is_update=True)
            self.backend.write(self.config.model, [record_id], write_row)
            return RowResult(
                ok=True,
                row_index=0,
                record_id=record_id,
                external_id=external_id,
                action="updated",
                strategy=strategy_used,
            )

        if db_id:
            return RowResult(
                ok=False,
                row_index=0,
                error=f"Record with .id={db_id} not found in {self.config.model}",
            )

        create_row = self._filter_writable(row, is_update=False)
        new_id = self.backend.create(self.config.model, create_row)
        if self.config.use_external_id and external_id:
            self._create_external_id(new_id, external_id)
        return RowResult(
            ok=True,
            row_index=0,
            record_id=new_id,
            external_id=external_id,
            action="created",
            strategy=STRATEGY_CREATE,
        )

    def _resolve_record(
        self,
        row: dict,
        external_id: str | None,
        db_id: int | None,
    ) -> tuple[int | None, str | None, list[str]]:
        """Find existing record using the standard lookup chain."""
        if self.config.use_external_id and external_id:
            record_id = self._find_by_external_id(external_id)
            if record_id:
                return record_id, STRATEGY_EXTERNAL_ID, []

        missing_keys: list[str] = []
        if self.config.search_keys:
            missing_keys = [
                k for k in self.config.search_keys if k not in row or row[k] == ""
            ]
            if not missing_keys:
                record_id = self._find_by_search_keys(row)
                if record_id:
                    return record_id, STRATEGY_SEARCH_KEYS, []

        if db_id:
            if self.backend.browse_exists(self.config.model, int(db_id)):
                return int(db_id), STRATEGY_DB_ID, []

        return None, None, missing_keys

    def _handle_explicit_operation(
        self,
        row: dict,
        operation: str,
        external_id: str | None,
        db_id: int | None,
    ) -> RowResult:
        """Handle explicit operation column (__op__: create, update, skip)."""
        operation = operation.lower().strip()

        if operation == OP_SKIP:
            return RowResult(
                ok=True,
                row_index=0,
                action="skipped",
                strategy=STRATEGY_EXPLICIT_OP,
            )

        elif operation == OP_CREATE:
            create_row = self._filter_writable(row, is_update=False)
            new_id = self.backend.create(self.config.model, create_row)
            if self.config.use_external_id and external_id:
                self._create_external_id(new_id, external_id)
            return RowResult(
                ok=True,
                row_index=0,
                record_id=new_id,
                external_id=external_id,
                action="created",
                strategy=STRATEGY_EXPLICIT_OP,
            )

        elif operation == OP_UPDATE:
            record_id, _, _ = self._resolve_record(row, external_id, db_id)
            if not record_id:
                return RowResult(
                    ok=False,
                    row_index=0,
                    error="Update requested but record not found",
                )
            write_row = self._filter_writable(row, is_update=True)
            self.backend.write(self.config.model, [record_id], write_row)
            return RowResult(
                ok=True,
                row_index=0,
                record_id=record_id,
                external_id=external_id,
                action="updated",
                strategy=STRATEGY_EXPLICIT_OP,
            )

        else:
            valid = ", ".join(sorted(VALID_OPERATIONS))
            return RowResult(
                ok=False,
                row_index=0,
                error=f"Unknown operation: {operation}. Valid: {valid}",
            )

    def _find_by_search_keys(self, row: dict) -> int | None:
        """Find record by natural key search. All keys must match exactly."""
        domain = [(key, "=", row[key]) for key in self.config.search_keys if key in row]
        if len(domain) != len(self.config.search_keys):
            return None

        ids = self.backend.search(self.config.model, domain, limit=2)
        if isinstance(ids, list) and len(ids) > 0:
            if isinstance(ids[0], dict):
                return ids[0]["id"]
            if len(ids) > 1:
                _logger.warning(
                    "Natural key search found %d records for %s. Using first.",
                    len(ids),
                    self.config.model,
                )
            return ids[0]
        return None

    def _find_by_external_id(self, external_id: str) -> int | None:
        """Find record by external ID (module.name format)."""
        if "." not in external_id:
            external_id = f"{DEFAULT_IMPORT_MODULE}.{external_id}"

        module, name = external_id.split(".", 1)

        results = self.backend.search_read(
            MODEL_IR_MODEL_DATA,
            [
                ("module", "=", module),
                ("name", "=", name),
                ("model", "=", self.config.model),
            ],
            ["res_id"],
            limit=1,
        )

        if results:
            res_id = results[0]["res_id"]
            if self.backend.browse_exists(self.config.model, res_id):
                return res_id
        return None

    def _create_external_id(self, record_id: int, external_id: str) -> None:
        """Create ir.model.data entry for external ID."""
        if "." in external_id:
            module, name = external_id.split(".", 1)
        else:
            module, name = DEFAULT_IMPORT_MODULE, external_id

        self.backend.create(
            MODEL_IR_MODEL_DATA,
            {
                "module": module,
                "name": name,
                "model": self.config.model,
                "res_id": record_id,
            },
        )
