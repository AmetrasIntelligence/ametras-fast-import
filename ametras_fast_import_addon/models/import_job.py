"""
Import job execution logic.

Extracted from CsvImportLog so the model stays focused on Odoo fields and actions.
ImportJob owns all stateful execution: control flow, progress tracking, retry, resume.
"""
import base64
import enum
import json
import logging
import time
from dataclasses import dataclass, field

from odoo import fields as odoo_fields

from .import_engine.constants import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_DELIMITER,
    DEFAULT_ENCODING,
    DEFAULT_RETRY_DELAY_MS,
    DEFAULT_RETRY_LIMIT,
    MAX_BATCH_SIZE,
    MAX_FINAL_ERROR_ENTRIES,
    MAX_POLL_ERROR_ENTRIES,
    MIN_BATCH_SIZE,
    PAUSE_POLL_INTERVAL_SECONDS,
    PROGRESS_COMMIT_INTERVAL,
)
from .import_engine.importer import ImportConfig, Importer
from .import_engine.parser import (
    ParseOptions,
    count_csv_rows,
    extract_rows_by_index,
    parse_csv_file,
    parse_csv_string,
)
from .orm_backend import OrmBackend

_logger = logging.getLogger(__name__)


class ControlSignal(enum.Enum):
    CONTINUE = "continue"
    CANCEL = "cancel"
    SKIP = "skip"


class ControlDecision(enum.Enum):
    """High-level decision returned by `_evaluate_control` after consulting
    cancel/skip/pause flags. Callers act on the decision; the helper handles
    the pause-wait and post-wait cancel re-check so the caller stays linear.
    """

    CONTINUE = "continue"
    STOP = "stop"  # cancel was requested (before or after the pause wait)
    SKIP_FILE = "skip_file"  # skip signal matches the current filename


@dataclass
class FileRunState:
    """Per-file counters accumulated during one import run."""

    filename: str
    success: int = 0
    failed: int = 0
    errors: list = field(default_factory=list)
    processed_indices: set = field(default_factory=set)
    base_success: int = 0  # success count carried in from a previous (resumed) run
    original_total: int = 0  # total row count from first run (stable across resumes)

    @property
    def cumulative_success(self) -> int:
        return self.base_success + self.success


class ImportJob:
    """Executes a single CSV import job. Instantiated with a csv.import.log record."""

    def __init__(self, log):
        self.log = log
        self.env = log.env

    # ------------------------------------------------------------------
    # Structured logging
    # ------------------------------------------------------------------

    def _log_event(self, event: str, **kwargs):
        """Emit a JSON-formatted structured log line for a lifecycle event.

        Every event carries job_id and event type so log lines can be
        correlated across files and retries without parsing free-form text.
        Example output:
            {"event": "file_done", "job_id": 42, "filename": "partners.csv",
             "success": 95, "failed": 5, "retried": 3, "duration_s": 1.23}
        """
        _logger.info(
            "%s", json.dumps({"event": event, "job_id": self.log.id, **kwargs})
        )

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def run(self):  # noqa: C901 — sequential orchestrator; splitting would obscure flow
        """Execute the full import. Called by the queue_job worker."""
        self.log.write({"job_state": "running"})
        self.env.cr.commit()

        config = json.loads(self.log.job_config)
        settings = config.get("settings", {})
        # Honor the user-selected import language so translatable fields
        # (name, description, …) are written in that language instead of the
        # job worker's default context — otherwise everything saves as English.
        lang = settings.get("lang")
        env = self.env.with_context(lang=lang) if lang else self.env
        backend = OrmBackend(env)
        batch_size = max(
            MIN_BATCH_SIZE,
            min(MAX_BATCH_SIZE, settings.get("batchSize", DEFAULT_BATCH_SIZE)),
        )
        encoding = settings.get("encoding", DEFAULT_ENCODING)
        delimiter = settings.get("delimiter", DEFAULT_DELIMITER)
        # `workers` is intentionally not read here: embedded mode runs batches
        # sequentially via a single Odoo cursor. The UI hides the workers knob
        # in embedded mode so profiles with workers > 1 normalise silently.

        import_sequence = config.get("importSequence", [])
        self._log_event(
            "job_start",
            files=import_sequence,
            batch_size=batch_size,
            dry_run=settings.get("dryRun", False),
        )

        all_success = 0
        all_failed = 0
        all_errors = []
        file_progress = json.loads(self.log.file_progress or "{}")
        last_commit = time.time()
        job_start_time = time.time()

        try:
            for filename in import_sequence:
                decision = self._evaluate_control(filename)
                if decision == ControlDecision.STOP:
                    break
                if decision == ControlDecision.SKIP_FILE:
                    self._mark_file_skipped(filename, file_progress)
                    self._log_event(
                        "file_skip", filename=filename, reason="user_requested"
                    )
                    continue

                self.log.write({"current_file": filename})
                self.env.cr.commit()

                file_mapping = config.get("fileMappings", {}).get(filename)
                if not file_mapping:
                    self._record_file_level_error(
                        filename,
                        f"No mapping found for file: {filename}",
                        all_errors,
                        file_progress,
                    )
                    self._log_event(
                        "file_error", filename=filename, reason="no_mapping"
                    )
                    continue

                attachment = self._get_attachment_by_name(filename)
                if not attachment:
                    self._record_file_level_error(
                        filename,
                        f"File not found: {filename}",
                        all_errors,
                        file_progress,
                    )
                    self._log_event(
                        "file_error", filename=filename, reason="attachment_missing"
                    )
                    continue

                options = ParseOptions(
                    delimiter=delimiter, encoding=encoding, has_header=True
                )
                file_path = self._get_attachment_path(attachment)

                if file_path:
                    # --- Streaming path: attachment stored on disk (large-file safe) ---
                    total_rows_count = count_csv_rows(
                        file_path, encoding, has_header=True
                    )

                    # Build skip set: rows already processed and not failed (resume support)
                    fp = file_progress.get(filename, {})
                    skip_indices: set[int] = set()
                    if fp.get("skipped"):
                        self._log_event(
                            "file_skip", filename=filename, reason="all_rows_processed"
                        )
                        continue
                    for start, end in fp.get("processedRanges", []):
                        skip_indices.update(range(start, end + 1))
                    failed_from_fp = set(fp.get("failedIndices", []))
                    skip_indices -= failed_from_fp  # re-process previously failed rows

                    # Early-exit when every row is already complete
                    if (
                        total_rows_count > 0
                        and len(skip_indices) >= total_rows_count
                        and not failed_from_fp
                    ):
                        self._log_event(
                            "file_skip", filename=filename, reason="all_rows_processed"
                        )
                        continue

                    if skip_indices:
                        pending_count = total_rows_count - len(skip_indices)
                        self._log_event(
                            "file_resume", filename=filename, pending_rows=pending_count
                        )

                    state = self._init_file_state(
                        filename, total_rows_count, file_progress
                    )
                    self._log_event(
                        "file_start",
                        filename=filename,
                        total_rows=state.original_total,
                        model=file_mapping.get("model"),
                    )
                    file_start_time = time.time()

                    import_config = ImportConfig(
                        model=file_mapping["model"],
                        field_mappings=file_mapping.get("fieldMappings", {}),
                        use_external_id=bool(
                            "id" in file_mapping.get("fieldMappings", {}).values()
                        ),
                        search_keys=file_mapping.get("searchKeys"),
                        dry_run=settings.get("dryRun", False),
                        strict=file_mapping.get("strict", False),
                        batch_size=batch_size,
                    )
                    importer = Importer(backend, import_config)

                    source = (
                        row
                        for row in parse_csv_file(file_path, options)
                        if row.index not in skip_indices
                    )
                    for batch in self._iter_batches(source, batch_size):
                        decision = self._evaluate_control(filename)
                        if decision == ControlDecision.STOP:
                            break
                        if decision == ControlDecision.SKIP_FILE:
                            break

                        for r in importer.import_rows(batch):
                            state.processed_indices.add(r.row_index)
                            if r.ok:
                                state.success += 1
                            else:
                                state.failed += 1
                                state.errors.append(
                                    {
                                        "filename": filename,
                                        "rowNumber": r.row_index,
                                        "error": r.error or "Unknown error",
                                    }
                                )

                        now = time.time()
                        if now - last_commit >= PROGRESS_COMMIT_INTERVAL:
                            self._save_progress(
                                state,
                                file_progress,
                                all_success + state.success,
                                all_failed + state.failed,
                                all_errors + state.errors,
                            )
                            last_commit = now

                    if self.log.job_skip_file == filename:
                        self._mark_file_skipped(filename, file_progress)
                        self._log_event(
                            "file_skip",
                            filename=filename,
                            reason="user_requested_mid_run",
                        )
                        all_success += state.success
                        all_failed += state.failed
                        all_errors.extend(state.errors)
                        continue

                    retry_results = []
                    retried = 0
                    if (
                        state.errors
                        and self._check_control() != ControlSignal.CANCEL
                        and state.success > 0
                    ):
                        retry_results = self._process_retries(
                            importer,
                            state.errors,
                            settings,
                            file_path=file_path,
                            options=options,
                        )
                        retried = len(retry_results)
                    for r in retry_results:
                        if r["ok"]:
                            state.success += 1
                            state.failed -= 1
                            state.processed_indices.add(r["rowNumber"])
                    succeeded = {r["rowNumber"] for r in retry_results if r["ok"]}
                    state.errors = [
                        e for e in state.errors if e["rowNumber"] not in succeeded
                    ]

                else:
                    # --- DB-stored path: small file, load into memory ---
                    content = base64.b64decode(attachment.datas).decode(
                        encoding, errors="replace"
                    )
                    rows = list(parse_csv_string(content, options))

                    pending = self._filter_pending_rows(filename, rows, file_progress)
                    if pending is not None:
                        rows = pending
                        if not rows:
                            self._log_event(
                                "file_skip",
                                filename=filename,
                                reason="all_rows_processed",
                            )
                            continue
                        self._log_event(
                            "file_resume", filename=filename, pending_rows=len(rows)
                        )

                    state = self._init_file_state(filename, len(rows), file_progress)
                    self._log_event(
                        "file_start",
                        filename=filename,
                        total_rows=state.original_total,
                        model=file_mapping.get("model"),
                    )
                    file_start_time = time.time()

                    import_config = ImportConfig(
                        model=file_mapping["model"],
                        field_mappings=file_mapping.get("fieldMappings", {}),
                        use_external_id=bool(
                            "id" in file_mapping.get("fieldMappings", {}).values()
                        ),
                        search_keys=file_mapping.get("searchKeys"),
                        dry_run=settings.get("dryRun", False),
                        strict=file_mapping.get("strict", False),
                        batch_size=batch_size,
                    )
                    importer = Importer(backend, import_config)

                    for i in range(0, len(rows), batch_size):
                        decision = self._evaluate_control(filename)
                        if decision == ControlDecision.STOP:
                            break
                        if decision == ControlDecision.SKIP_FILE:
                            break

                        for r in importer.import_rows(rows[i : i + batch_size]):
                            state.processed_indices.add(r.row_index)
                            if r.ok:
                                state.success += 1
                            else:
                                state.failed += 1
                                state.errors.append(
                                    {
                                        "filename": filename,
                                        "rowNumber": r.row_index,
                                        "error": r.error or "Unknown error",
                                    }
                                )

                        now = time.time()
                        if now - last_commit >= PROGRESS_COMMIT_INTERVAL:
                            self._save_progress(
                                state,
                                file_progress,
                                all_success + state.success,
                                all_failed + state.failed,
                                all_errors + state.errors,
                            )
                            last_commit = now

                    if self.log.job_skip_file == filename:
                        self._mark_file_skipped(filename, file_progress)
                        self._log_event(
                            "file_skip",
                            filename=filename,
                            reason="user_requested_mid_run",
                        )
                        all_success += state.success
                        all_failed += state.failed
                        all_errors.extend(state.errors)
                        continue

                    retry_results = []
                    retried = 0
                    if (
                        state.errors
                        and self._check_control() != ControlSignal.CANCEL
                        and state.success > 0
                    ):
                        retry_results = self._process_retries(
                            importer,
                            state.errors,
                            settings,
                            all_rows=rows,
                        )
                        retried = len(retry_results)
                    for r in retry_results:
                        if r["ok"]:
                            state.success += 1
                            state.failed -= 1
                            state.processed_indices.add(r["rowNumber"])
                    succeeded = {r["rowNumber"] for r in retry_results if r["ok"]}
                    state.errors = [
                        e for e in state.errors if e["rowNumber"] not in succeeded
                    ]

                self._log_event(
                    "file_done",
                    filename=filename,
                    success=state.success,
                    failed=state.failed,
                    retried=retried,
                    duration_s=round(time.time() - file_start_time, 2),
                )

                all_success += state.success
                all_failed += state.failed
                all_errors.extend(state.errors)
                self._save_progress(
                    state, file_progress, all_success, all_failed, all_errors
                )
                last_commit = time.time()

            final_state = "failed" if all_errors else "completed"
            if self._check_control() == ControlSignal.CANCEL:
                final_state = "interrupted"

            self._log_event(
                "job_done",
                final_state=final_state,
                total_success=all_success,
                total_failed=all_failed,
                duration_s=round(time.time() - job_start_time, 2),
            )
            self._finalize(
                final_state, all_success, all_failed, all_errors, file_progress
            )

        except Exception as e:
            _logger.exception("Import job %d failed: %s", self.log.id, e)
            self._log_event("job_failed", error=str(e))
            all_errors.append({"filename": "", "rowNumber": 0, "error": str(e)})
            self._finalize("failed", all_success, all_failed, all_errors, file_progress)

    # ------------------------------------------------------------------
    # Control flow
    # ------------------------------------------------------------------

    def _evaluate_control(self, filename: str) -> ControlDecision:
        """Single checkpoint used by both the file loop and the batch loop.

        Order matters: cancel beats skip; pause is waited out before the second
        cancel re-check so a cancel issued during the wait is still respected.
        """
        signal = self._check_control()
        if signal == ControlSignal.CANCEL:
            return ControlDecision.STOP
        if signal == ControlSignal.SKIP and self.log.job_skip_file == filename:
            return ControlDecision.SKIP_FILE

        self._wait_if_paused()
        if self._check_control() == ControlSignal.CANCEL:
            return ControlDecision.STOP
        return ControlDecision.CONTINUE

    def _check_control(self) -> ControlSignal:
        """Read DB flags and return the current control signal."""
        self._refresh_flags()
        if self.log.job_cancel_requested:
            return ControlSignal.CANCEL
        if self.log.job_skip_file:
            return ControlSignal.SKIP
        return ControlSignal.CONTINUE

    def _refresh_flags(self):
        """Re-read control flags from DB (Vue writes them via the control endpoint)."""
        # Table name is the ORM model's _table (not user input), so S608 is safe.
        self.env.cr.execute(
            "SELECT job_cancel_requested, job_pause_requested, job_skip_file "
            f"FROM {self.log._table} WHERE id = %s",  # noqa: S608
            (self.log.id,),
        )
        row = self.env.cr.fetchone()
        if row:
            self.log.job_cancel_requested = row[0]
            self.log.job_pause_requested = row[1]
            self.log.job_skip_file = row[2] or ""

    def _wait_if_paused(self):
        """Block until the pause flag is cleared. Polls DB every 2 seconds.

        Also unblocks immediately on CANCEL or SKIP so the caller's post-wait
        control check handles those signals without extra latency.
        """
        was_paused = False
        while True:
            self._refresh_flags()
            if not self.log.job_pause_requested:
                break
            if self.log.job_cancel_requested:
                return
            # A skip posted while paused should unblock immediately; the
            # caller's _check_control() will see and act on the SKIP signal.
            if self.log.job_skip_file:
                self.log.write({"job_pause_requested": False})
                self.env.cr.commit()
                break
            was_paused = True
            self.log.write({"job_state": "paused"})
            self.env.cr.commit()
            time.sleep(PAUSE_POLL_INTERVAL_SECONDS)
        if was_paused:
            self.log.write({"job_state": "running"})
            self.env.cr.commit()

    # ------------------------------------------------------------------
    # File helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _make_empty_file_progress(**overrides) -> dict:
        """Canonical empty file_progress entry. Pass overrides like skipped=True."""
        entry = {
            "totalRows": 0,
            "successCount": 0,
            "failedCount": 0,
            "processedRanges": [],
            "failedIndices": [],
        }
        entry.update(overrides)
        return entry

    def _get_attachment_by_name(self, filename):
        for att in self.log.attachment_ids:
            if att.name == filename:
                return att
        return None

    def _get_attachment_path(self, attachment) -> "str | None":
        """Return on-disk path for filestore-backed attachments, or None."""
        if attachment.store_fname:
            return attachment._full_path(attachment.store_fname)
        return None

    @staticmethod
    def _iter_batches(source, batch_size: int):
        """Yield successive batches of up to batch_size rows from source iterator."""
        batch = []
        for row in source:
            batch.append(row)
            if len(batch) >= batch_size:
                yield batch
                batch = []
        if batch:
            yield batch

    def _record_file_level_error(self, filename, message, all_errors, file_progress):
        """Record a whole-file error (missing mapping, missing attachment, ...)."""
        all_errors.append({"filename": filename, "rowNumber": 0, "error": message})
        file_progress[filename] = self._make_empty_file_progress()

    def _mark_file_skipped(self, filename, file_progress):
        # Drop failedIndices for skipped files — there's nothing to retry.
        entry = self._make_empty_file_progress(skipped=True)
        entry.pop("failedIndices", None)
        file_progress[filename] = entry
        self.log.write(
            {"job_skip_file": "", "file_progress": json.dumps(file_progress)}
        )
        self.env.cr.commit()

    def _init_file_state(
        self, filename, total_rows: int, file_progress
    ) -> FileRunState:
        """Build initial FileRunState, pre-loading base progress for resume runs."""
        base_fp = file_progress.get(filename, {})
        state = FileRunState(
            filename=filename,
            base_success=base_fp.get("successCount", 0),
            original_total=base_fp.get("totalRows") or total_rows,
        )
        for rng in base_fp.get("processedRanges", []):
            state.processed_indices.update(range(rng[0], rng[1] + 1))
        return state

    def _filter_pending_rows(self, filename, all_rows, file_progress):
        """Return rows that still need processing, or None if this is a fresh run."""
        if filename not in file_progress:
            return None

        fp = file_progress[filename]
        if fp.get("skipped"):
            return []

        processed_ranges = fp.get("processedRanges", [])
        if not processed_ranges and not fp.get("totalRows", 0):
            return None

        processed = set()
        for start, end in processed_ranges:
            processed.update(range(start, end + 1))

        failed_indices = set(fp.get("failedIndices", []))
        target_indices = {
            row.index
            for row in all_rows
            if row.index not in processed or row.index in failed_indices
        }

        if not target_indices:
            return []

        return [row for row in all_rows if row.index in target_indices]

    # ------------------------------------------------------------------
    # Retry
    # ------------------------------------------------------------------

    def _process_retries(
        self,
        importer,
        file_errors,
        settings,
        *,
        all_rows=None,
        file_path=None,
        options=None,
    ):
        """Retry failed rows up to retryLimit times. Returns list of retry results."""
        max_retries = settings.get("retryLimit", DEFAULT_RETRY_LIMIT)
        retry_delay = settings.get("retryDelayMs", DEFAULT_RETRY_DELAY_MS) / 1000.0

        remaining_errors = list(file_errors)
        all_retry_results = []

        for attempt in range(max_retries):
            failed_indices = {
                e["rowNumber"] for e in remaining_errors if e.get("rowNumber", 0) > 0
            }
            if not failed_indices:
                break

            if file_path is not None and options is not None:
                retry_rows = list(
                    extract_rows_by_index(file_path, failed_indices, options)
                )
            elif all_rows is not None:
                retry_rows = [r for r in all_rows if r.index in failed_indices]
            else:
                break

            if not retry_rows:
                break

            if retry_delay > 0:
                time.sleep(retry_delay)

            if self._check_control() == ControlSignal.CANCEL:
                break

            results = importer.import_rows(retry_rows)
            attempt_results = [
                {"rowNumber": r.row_index, "ok": r.ok, "error": r.error}
                for r in results
            ]
            all_retry_results.extend(attempt_results)

            succeeded = {r["rowNumber"] for r in attempt_results if r["ok"]}
            filename = (
                remaining_errors[0].get("filename", "") if remaining_errors else ""
            )
            self._log_event(
                "retry_attempt",
                filename=filename,
                attempt=attempt + 1,
                rows=len(retry_rows),
                succeeded=len(succeeded),
            )

            remaining_errors = [
                e for e in remaining_errors if e["rowNumber"] not in succeeded
            ]

            if not remaining_errors:
                break

        return all_retry_results

    # ------------------------------------------------------------------
    # Progress persistence
    # ------------------------------------------------------------------

    def _save_progress(
        self, state: FileRunState, file_progress, all_success, all_failed, all_errors
    ):
        """Commit current progress to DB so Vue can poll it."""
        failed_indices = sorted(
            {
                e["rowNumber"]
                for e in all_errors
                if e.get("filename") == state.filename and e.get("rowNumber", 0) > 0
            }
        )
        file_progress[state.filename] = {
            "totalRows": state.original_total,
            "successCount": state.cumulative_success,
            "failedCount": state.failed,
            "processedRanges": self._indices_to_ranges(state.processed_indices),
            "failedIndices": failed_indices,
        }
        self.log.write(
            {
                "success_rows": all_success,
                "failed_rows": all_failed,
                "file_progress": json.dumps(file_progress),
                "error_log": json.dumps(all_errors[-MAX_POLL_ERROR_ENTRIES:]),
                "heartbeat": odoo_fields.Datetime.now(),
            }
        )
        self.env.cr.commit()

    # ------------------------------------------------------------------
    # Finalization
    # ------------------------------------------------------------------

    def _finalize(
        self, final_state, all_success, all_failed, all_errors, file_progress
    ):
        """Single write that closes the job. Used by the happy path, the
        cancel-detected path, and the exception handler.
        """
        self.log.write(
            {
                "job_state": final_state,
                "state": final_state,
                "finished_at": odoo_fields.Datetime.now(),
                "success_rows": all_success,
                "failed_rows": all_failed,
                "total_rows": all_success + all_failed,
                "error_log": json.dumps(all_errors[-MAX_FINAL_ERROR_ENTRIES:]),
                "file_progress": json.dumps(file_progress),
                "current_file": "",
            }
        )
        self.env.cr.commit()

    @staticmethod
    def _indices_to_ranges(indices):
        """Convert a set of row indices to compact sorted [start, end] ranges."""
        if not indices:
            return []
        sorted_idx = sorted(indices)
        ranges = []
        start = end = sorted_idx[0]
        for i in sorted_idx[1:]:
            if i == end + 1:
                end = i
            else:
                ranges.append([start, end])
                start = end = i
        ranges.append([start, end])
        return ranges
