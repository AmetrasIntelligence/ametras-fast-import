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

_logger = logging.getLogger(__name__)


class ControlSignal(enum.Enum):
    CONTINUE = 'continue'
    CANCEL = 'cancel'
    SKIP = 'skip'


@dataclass
class FileRunState:
    """Per-file counters accumulated during one import run."""
    filename: str
    success: int = 0
    failed: int = 0
    errors: list = field(default_factory=list)
    processed_indices: set = field(default_factory=set)
    base_success: int = 0   # success count carried in from a previous (resumed) run
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
    # Public entry point
    # ------------------------------------------------------------------

    def run(self):
        """Execute the full import. Called by the queue_job worker."""
        from .odoo_backend import OrmBackend
        from .import_engine.importer import Importer, ImportConfig
        from .import_engine.parser import ParseOptions, parse_csv_string
        from .import_engine.constants import PROGRESS_COMMIT_INTERVAL

        self.log.write({'job_state': 'running'})
        self.env.cr.commit()

        config = json.loads(self.log.job_config)
        backend = OrmBackend(self.env)
        settings = config.get('settings', {})
        batch_size = max(10, min(1000, settings.get('batchSize', 200)))
        encoding = settings.get('encoding', 'utf-8')
        delimiter = settings.get('delimiter', ',')

        all_success = 0
        all_failed = 0
        all_errors = []
        file_progress = json.loads(self.log.file_progress or '{}')
        last_commit = time.time()

        try:
            for filename in config.get('importSequence', []):
                signal = self._check_control()
                if signal == ControlSignal.CANCEL:
                    break
                if signal == ControlSignal.SKIP and self.log.job_skip_file == filename:
                    self._mark_file_skipped(filename, file_progress)
                    continue

                self._wait_if_paused()
                if self._check_control() == ControlSignal.CANCEL:
                    break

                self.log.write({'current_file': filename})
                self.env.cr.commit()

                file_mapping = config.get('fileMappings', {}).get(filename)
                if not file_mapping:
                    all_errors.append({
                        'filename': filename, 'rowNumber': 0,
                        'error': f'No mapping found for file: {filename}',
                    })
                    file_progress[filename] = {
                        'totalRows': 0, 'successCount': 0, 'failedCount': 0,
                        'processedRanges': [], 'failedIndices': [],
                    }
                    continue

                attachment = self._get_attachment_by_name(filename)
                if not attachment:
                    all_errors.append({
                        'filename': filename, 'rowNumber': 0,
                        'error': f'File not found: {filename}',
                    })
                    file_progress[filename] = {
                        'totalRows': 0, 'successCount': 0, 'failedCount': 0,
                        'processedRanges': [], 'failedIndices': [],
                    }
                    continue

                content = base64.b64decode(attachment.datas).decode(encoding, errors='replace')
                options = ParseOptions(delimiter=delimiter, encoding=encoding, has_header=True)
                rows = list(parse_csv_string(content, options))

                pending = self._filter_pending_rows(filename, rows, file_progress)
                if pending is not None:
                    rows = pending
                    if not rows:
                        _logger.info("Skipping %s: all rows already processed", filename)
                        continue

                state = self._init_file_state(filename, rows, file_progress)

                import_config = ImportConfig(
                    model=file_mapping['model'],
                    field_mappings=file_mapping.get('fieldMappings', {}),
                    use_external_id=bool(
                        'id' in file_mapping.get('fieldMappings', {}).values()
                    ),
                    search_keys=file_mapping.get('searchKeys'),
                    dry_run=settings.get('dryRun', False),
                    strict=file_mapping.get('strict', False),
                    batch_size=batch_size,
                )
                importer = Importer(backend, import_config)

                for i in range(0, len(rows), batch_size):
                    signal = self._check_control()
                    if signal == ControlSignal.CANCEL:
                        break
                    if signal == ControlSignal.SKIP and self.log.job_skip_file == filename:
                        break

                    self._wait_if_paused()
                    if self._check_control() == ControlSignal.CANCEL:
                        break

                    for r in importer.import_rows(rows[i:i + batch_size]):
                        state.processed_indices.add(r.row_index)
                        if r.ok:
                            state.success += 1
                        else:
                            state.failed += 1
                            state.errors.append({
                                'filename': filename,
                                'rowNumber': r.row_index,
                                'error': r.error or 'Unknown error',
                            })

                    now = time.time()
                    if now - last_commit >= PROGRESS_COMMIT_INTERVAL:
                        self._save_progress(
                            state, file_progress,
                            all_success + state.success,
                            all_failed + state.failed,
                            all_errors + state.errors,
                        )
                        last_commit = now

                if self.log.job_skip_file == filename:
                    self._mark_file_skipped(filename, file_progress)
                    all_success += state.success
                    all_failed += state.failed
                    all_errors.extend(state.errors)
                    continue

                # Retry failed rows — only when some rows succeeded, which suggests
                # ordering dependencies rather than systematic data errors.
                if state.errors and self._check_control() != ControlSignal.CANCEL and state.success > 0:
                    retry_results = self._process_retries(importer, rows, state.errors, settings)
                    for r in retry_results:
                        if r['ok']:
                            state.success += 1
                            state.failed -= 1
                            state.processed_indices.add(r['rowNumber'])
                    succeeded = {r['rowNumber'] for r in retry_results if r['ok']}
                    state.errors = [e for e in state.errors if e['rowNumber'] not in succeeded]

                all_success += state.success
                all_failed += state.failed
                all_errors.extend(state.errors)
                self._save_progress(state, file_progress, all_success, all_failed, all_errors)
                last_commit = time.time()

            final_state = 'failed' if (all_failed > 0 or all_errors) else 'completed'
            if self._check_control() == ControlSignal.CANCEL:
                final_state = 'interrupted'

            self.log.write({
                'job_state': final_state,
                'state': final_state,
                'finished_at': odoo_fields.Datetime.now(),
                'success_rows': all_success,
                'failed_rows': all_failed,
                'total_rows': all_success + all_failed,
                'error_log': json.dumps(all_errors),
                'file_progress': json.dumps(file_progress),
                'current_file': '',
            })
            self.env.cr.commit()

        except Exception as e:
            _logger.exception("Import job %d failed: %s", self.log.id, e)
            self.log.write({
                'job_state': 'failed',
                'state': 'failed',
                'finished_at': odoo_fields.Datetime.now(),
                'success_rows': all_success,
                'failed_rows': all_failed,
                'error_log': json.dumps(all_errors + [
                    {'filename': '', 'rowNumber': 0, 'error': str(e)},
                ]),
                'file_progress': json.dumps(file_progress),
                'current_file': '',
            })
            self.env.cr.commit()

    # ------------------------------------------------------------------
    # Control flow
    # ------------------------------------------------------------------

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
        self.env.cr.execute(
            "SELECT job_cancel_requested, job_pause_requested, job_skip_file "
            "FROM csv_import_log WHERE id = %s",
            (self.log.id,)
        )
        row = self.env.cr.fetchone()
        if row:
            self.log.job_cancel_requested = row[0]
            self.log.job_pause_requested = row[1]
            self.log.job_skip_file = row[2] or ''

    def _wait_if_paused(self):
        """Block until the pause flag is cleared. Polls DB every 2 seconds."""
        was_paused = False
        while True:
            self._refresh_flags()
            if not self.log.job_pause_requested:
                break
            if self.log.job_cancel_requested:
                return
            was_paused = True
            self.log.write({'job_state': 'paused'})
            self.env.cr.commit()
            time.sleep(2)
        if was_paused:
            self.log.write({'job_state': 'running'})
            self.env.cr.commit()

    # ------------------------------------------------------------------
    # File helpers
    # ------------------------------------------------------------------

    def _get_attachment_by_name(self, filename):
        for att in self.log.attachment_ids:
            if att.name == filename:
                return att
        return None

    def _mark_file_skipped(self, filename, file_progress):
        file_progress[filename] = {
            'totalRows': 0, 'successCount': 0, 'failedCount': 0,
            'processedRanges': [], 'skipped': True,
        }
        self.log.write({'job_skip_file': '', 'file_progress': json.dumps(file_progress)})
        self.env.cr.commit()

    def _init_file_state(self, filename, rows, file_progress) -> FileRunState:
        """Build initial FileRunState, pre-loading base progress for resume runs."""
        base_fp = file_progress.get(filename, {})
        state = FileRunState(
            filename=filename,
            base_success=base_fp.get('successCount', 0),
            original_total=base_fp.get('totalRows') or len(rows),
        )
        for rng in base_fp.get('processedRanges', []):
            state.processed_indices.update(range(rng[0], rng[1] + 1))
        return state

    def _filter_pending_rows(self, filename, all_rows, file_progress):
        """Return rows that still need processing, or None if this is a fresh run."""
        if filename not in file_progress:
            return None

        fp = file_progress[filename]
        if fp.get('skipped'):
            return []

        processed_ranges = fp.get('processedRanges', [])
        if not processed_ranges and not fp.get('totalRows', 0):
            return None

        processed = set()
        for start, end in processed_ranges:
            processed.update(range(start, end + 1))

        failed_indices = set(fp.get('failedIndices', []))
        target_indices = {
            row.index for row in all_rows
            if row.index not in processed or row.index in failed_indices
        }

        if not target_indices:
            return []

        return [row for row in all_rows if row.index in target_indices]

    # ------------------------------------------------------------------
    # Retry
    # ------------------------------------------------------------------

    def _process_retries(self, importer, all_rows, file_errors, settings):
        """Retry failed rows up to retryLimit times. Returns list of retry results."""
        max_retries = settings.get('retryLimit', 3)
        retry_delay = settings.get('retryDelayMs', 500) / 1000.0

        remaining_errors = list(file_errors)
        all_retry_results = []

        for _ in range(max_retries):
            failed_indices = {
                e['rowNumber'] for e in remaining_errors if e.get('rowNumber', 0) > 0
            }
            if not failed_indices:
                break

            retry_rows = [r for r in all_rows if r.index in failed_indices]
            if not retry_rows:
                break

            if retry_delay > 0:
                time.sleep(retry_delay)

            if self._check_control() == ControlSignal.CANCEL:
                break

            results = importer.import_rows(retry_rows)
            attempt_results = [
                {'rowNumber': r.row_index, 'ok': r.ok, 'error': r.error}
                for r in results
            ]
            all_retry_results.extend(attempt_results)

            succeeded = {r['rowNumber'] for r in attempt_results if r['ok']}
            remaining_errors = [e for e in remaining_errors if e['rowNumber'] not in succeeded]

            if not remaining_errors:
                break

        return all_retry_results

    # ------------------------------------------------------------------
    # Progress persistence
    # ------------------------------------------------------------------

    def _save_progress(self, state: FileRunState, file_progress,
                       all_success, all_failed, all_errors):
        """Commit current progress to DB so Vue can poll it."""
        failed_indices = sorted({
            e['rowNumber'] for e in all_errors
            if e.get('filename') == state.filename and e.get('rowNumber', 0) > 0
        })
        file_progress[state.filename] = {
            'totalRows': state.original_total,
            'successCount': state.cumulative_success,
            'failedCount': state.failed,
            'processedRanges': self._indices_to_ranges(state.processed_indices),
            'failedIndices': failed_indices,
        }
        self.log.write({
            'success_rows': all_success,
            'failed_rows': all_failed,
            'file_progress': json.dumps(file_progress),
            'error_log': json.dumps(all_errors[-100:]),  # keep last 100 for polling
            'heartbeat': odoo_fields.Datetime.now(),
        })
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
