import base64
import json
import logging
import time

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# How often to commit progress during import (seconds)
PROGRESS_COMMIT_INTERVAL = 10


class CsvImportLog(models.Model):
    _name = 'csv.import.log'
    _description = 'CSV Import Log'
    _order = 'create_date desc'

    # Metadata
    profile_name = fields.Char(string='Profile')
    profile_id = fields.Many2one('csv.import.profile', string='Profile Record', ondelete='set null')
    user_id = fields.Many2one('res.users', string='User', default=lambda self: self.env.user, required=True)
    is_dry_run = fields.Boolean(string='Dry Run', default=False)
    state = fields.Selection([
        ('running', 'Running'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
        ('interrupted', 'Interrupted'),
    ], string='State', default='running')

    # ----- Job execution fields -----
    job_config = fields.Text(string='Job Config (JSON)', default='{}')
    job_state = fields.Selection([
        ('draft', 'Draft'),
        ('pending', 'Pending'),
        ('running', 'Running'),
        ('paused', 'Paused'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
        ('interrupted', 'Interrupted'),
    ], string='Job State', default='draft')
    job_cancel_requested = fields.Boolean(default=False)
    job_pause_requested = fields.Boolean(default=False)
    job_skip_file = fields.Char(string='File to Skip', default='')
    current_file = fields.Char(string='Current File', default='')

    # Timing
    started_at = fields.Datetime(string='Started', required=True)
    finished_at = fields.Datetime(string='Finished')
    duration_seconds = fields.Integer(string='Duration (s)', compute='_compute_duration', store=True)
    heartbeat = fields.Datetime(string='Last Heartbeat')

    # Files
    filenames = fields.Text(string='Filenames (JSON)', default='[]')
    attachment_ids = fields.Many2many(
        'ir.attachment', 'csv_import_log_attachment_rel',
        'log_id', 'attachment_id', string='Import Files',
    )

    # Results
    total_rows = fields.Integer(string='Total Rows')
    success_rows = fields.Integer(string='Successful')
    failed_rows = fields.Integer(string='Failed')
    pending_rows = fields.Integer(
        string='Pending', compute='_compute_pending_rows', store=True,
    )

    # Progress tracking (JSON: per-file processed ranges + counts)
    file_progress = fields.Text(string='File Progress (JSON)', default='{}')

    # Error log
    error_log = fields.Text(string='Error Log (JSON)', default='[]')

    @api.depends('started_at', 'finished_at')
    def _compute_duration(self):
        for rec in self:
            if rec.started_at and rec.finished_at:
                delta = rec.finished_at - rec.started_at
                rec.duration_seconds = int(delta.total_seconds())
            else:
                rec.duration_seconds = 0

    @api.depends('total_rows', 'success_rows', 'failed_rows')
    def _compute_pending_rows(self):
        for rec in self:
            rec.pending_rows = max(0, rec.total_rows - rec.success_rows - rec.failed_rows)

    @api.model
    def action_start_new_import(self):
        """Open the import wizard in a dialog."""
        return {
            'type': 'ir.actions.client',
            'tag': 'ametras_csv_import_vue_app',
            'name': 'CSV Import',
            'target': 'new',
            'params': {'default_view': 'import'},
            'context': {'dialog_size': 'extra-large'},
        }

    def action_open_log(self):
        """Open the appropriate Vue view based on log state."""
        self.ensure_one()
        params = {}
        if self.state == 'running':
            params.update(default_view='run', resume_log_id=self.id)
        elif self.state in ('completed', 'failed'):
            params.update(default_view='results', log_id=self.id)
        elif self.state == 'interrupted':
            params.update(default_view='import', resume_log_id=self.id)
        else:
            params['default_view'] = 'import'
        return {
            'type': 'ir.actions.client',
            'tag': 'ametras_csv_import_vue_app',
            'name': 'Import',
            'target': 'new',
            'params': params,
            'context': {'dialog_size': 'extra-large'},
        }

    def action_retry_failed(self):
        """Open the Import client action for retrying failed rows."""
        self.ensure_one()
        return {
            'type': 'ir.actions.client',
            'tag': 'ametras_csv_import_vue_app',
            'name': 'Retry Import',
            'params': {
                'default_view': 'import',
                'retry_log_id': self.id,
            },
        }

    def action_resume_import(self):
        """Open Import Vue app with context to resume this import."""
        self.ensure_one()
        return {
            'type': 'ir.actions.client',
            'tag': 'ametras_csv_import_vue_app',
            'name': 'Resume Import',
            'params': {
                'default_view': 'import',
                'resume_log_id': self.id,
            },
        }

    def action_download_errors(self):
        """Download error log as CSV file."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_url',
            'url': f'/ametras_fast_import/log/{self.id}/error_csv',
            'target': 'self',
        }

    # -----------------------------------------------------------------
    # Server-side import job execution
    # -----------------------------------------------------------------

    def action_start_import(self):
        """Start background import job via queue_job."""
        self.ensure_one()
        self.write({
            'job_state': 'pending',
            'state': 'running',
            'started_at': fields.Datetime.now(),
            'job_cancel_requested': False,  # Clear from previous run
            'job_pause_requested': False,
            'job_skip_file': '',
        })
        self.with_delay(
            channel='root.csv_import',
            description=f'CSV Import: {self.profile_name or self.id}',
            max_retries=0,
        )._execute_import()

    def _execute_import(self):
        """
        Run the full import. Executed by queue_job worker.

        Handles all edge cases: cancel, pause, skip, retry, per-row errors.
        Progress is committed periodically so Vue can poll it.
        """
        from .orm_backend import OrmBackend
        from .import_engine.importer import Importer, ImportConfig
        from .import_engine.parser import ParsedRow, ParseOptions, parse_csv_string

        self.write({'job_state': 'running'})
        self.env.cr.commit()

        config = json.loads(self.job_config)
        backend = OrmBackend(self.env)
        settings = config.get('settings', {})
        batch_size = max(10, min(1000, settings.get('batchSize', 200)))
        encoding = settings.get('encoding', 'utf-8')
        delimiter = settings.get('delimiter', ',')

        all_success = 0
        all_failed = 0
        all_errors = []
        file_progress = json.loads(self.file_progress or '{}')
        last_commit = time.time()

        try:
            for filename in config.get('importSequence', []):
                # EC1: Check cancel before each file
                if self._is_cancelled():
                    break

                # EC2: Check skip for this file
                self._refresh_flags()
                if self.job_skip_file == filename:
                    self._mark_file_skipped(filename, file_progress)
                    continue

                # EC3: Check pause
                self._wait_if_paused()
                if self._is_cancelled():
                    break

                self.write({'current_file': filename})
                self.env.cr.commit()

                file_mapping = config.get('fileMappings', {}).get(filename)
                if not file_mapping:
                    all_errors.append({
                        'filename': filename, 'rowNumber': 0,
                        'error': f'No mapping found for file: {filename}',
                    })
                    continue

                # Get CSV content from ir.attachment
                attachment = self._get_attachment_by_name(filename)
                if not attachment:
                    all_errors.append({
                        'filename': filename, 'rowNumber': 0,
                        'error': f'File not found: {filename}',
                    })
                    continue

                content = base64.b64decode(attachment.datas).decode(encoding, errors='replace')
                options = ParseOptions(
                    delimiter=delimiter, encoding=encoding, has_header=True,
                )
                rows = list(parse_csv_string(content, options))

                # EC4: Resume — filter to pending + failed rows
                resume_rows = self._get_resume_rows(filename, rows, file_progress)
                if resume_rows is not None:
                    rows = resume_rows
                    if not rows:
                        _logger.info("Skipping %s: all rows already processed", filename)
                        continue

                total_file_rows = len(rows)
                file_success = 0
                file_failed = 0
                file_errors = []
                processed_indices = set()

                import_config = ImportConfig(
                    model=file_mapping['model'],
                    field_mappings=file_mapping.get('fieldMappings', {}),
                    use_external_id=bool(file_mapping.get('fieldMappings', {}).values()
                                         and 'id' in file_mapping.get('fieldMappings', {}).values()),
                    search_keys=file_mapping.get('searchKeys'),
                    dry_run=settings.get('dryRun', False),
                    strict=file_mapping.get('strict', False),
                    batch_size=batch_size,
                )
                importer = Importer(backend, import_config)

                # Process in batches
                for i in range(0, len(rows), batch_size):
                    # EC1: Check cancel between batches
                    if self._is_cancelled():
                        break

                    # EC2: Check skip between batches
                    self._refresh_flags()
                    if self.job_skip_file == filename:
                        break

                    # EC3: Check pause between batches
                    self._wait_if_paused()
                    if self._is_cancelled():
                        break

                    batch = rows[i:i + batch_size]
                    results = importer.import_rows(batch)

                    for r in results:
                        processed_indices.add(r.row_index)
                        if r.ok:
                            file_success += 1
                        else:
                            file_failed += 1
                            file_errors.append({
                                'filename': filename,
                                'rowNumber': r.row_index,
                                'error': r.error or 'Unknown error',
                            })

                    # Periodic commit of progress
                    now = time.time()
                    if now - last_commit >= PROGRESS_COMMIT_INTERVAL:
                        self._commit_file_progress(
                            filename, file_progress, processed_indices,
                            total_file_rows, file_success, file_failed,
                            all_success + file_success, all_failed + file_failed,
                            all_errors + file_errors,
                        )
                        last_commit = now

                # EC2: File was skipped mid-processing
                if self.job_skip_file == filename:
                    self._mark_file_skipped(filename, file_progress)
                    all_success += file_success
                    all_failed += file_failed
                    all_errors.extend(file_errors)
                    continue

                # EC5: Retry failed rows for this file
                if file_errors and not self._is_cancelled():
                    retry_results = self._process_retries(
                        filename, importer, rows, file_errors, settings
                    )
                    for r in retry_results:
                        if r['ok']:
                            file_success += 1
                            file_failed -= 1
                            processed_indices.add(r['rowNumber'])
                    # Update file_errors: keep only still-failed
                    succeeded_rows = {r['rowNumber'] for r in retry_results if r['ok']}
                    file_errors = [e for e in file_errors if e['rowNumber'] not in succeeded_rows]

                # Finalize file progress
                all_success += file_success
                all_failed += file_failed
                all_errors.extend(file_errors)
                self._commit_file_progress(
                    filename, file_progress, processed_indices,
                    total_file_rows, file_success, file_failed,
                    all_success, all_failed, all_errors,
                )
                last_commit = time.time()

            # Finalize
            final_state = 'failed' if (all_failed > 0 or all_errors) else 'completed'
            if self._is_cancelled():
                final_state = 'interrupted'

            self.write({
                'job_state': final_state,
                'state': final_state if final_state != 'interrupted' else 'interrupted',
                'finished_at': fields.Datetime.now(),
                'success_rows': all_success,
                'failed_rows': all_failed,
                'total_rows': all_success + all_failed,
                'error_log': json.dumps(all_errors),
                'file_progress': json.dumps(file_progress),
                'current_file': '',
            })
            self.env.cr.commit()

        except Exception as e:
            _logger.exception("Import job %d failed: %s", self.id, e)
            self.write({
                'job_state': 'failed',
                'state': 'failed',
                'finished_at': fields.Datetime.now(),
                'success_rows': all_success,
                'failed_rows': all_failed,
                'error_log': json.dumps(all_errors + [{
                    'filename': '', 'rowNumber': 0, 'error': str(e),
                }]),
                'file_progress': json.dumps(file_progress),
                'current_file': '',
            })
            self.env.cr.commit()

    def _refresh_flags(self):
        """Re-read control flags from DB (written by Vue via control endpoint)."""
        self.env.cr.execute(
            "SELECT job_cancel_requested, job_pause_requested, job_skip_file "
            "FROM csv_import_log WHERE id = %s",
            (self.id,)
        )
        row = self.env.cr.fetchone()
        if row:
            self.job_cancel_requested = row[0]
            self.job_pause_requested = row[1]
            self.job_skip_file = row[2] or ''

    def _is_cancelled(self):
        self._refresh_flags()
        return self.job_cancel_requested

    def _wait_if_paused(self):
        """Block until pause flag is cleared. Polls DB every 2 seconds."""
        was_paused = False
        while True:
            self._refresh_flags()
            if not self.job_pause_requested:
                break
            if self.job_cancel_requested:
                return
            was_paused = True
            self.write({'job_state': 'paused'})
            self.env.cr.commit()
            time.sleep(2)
        if was_paused:
            self.write({'job_state': 'running'})
            self.env.cr.commit()

    def _mark_file_skipped(self, filename, file_progress):
        """Mark a file as skipped in progress."""
        file_progress[filename] = {
            'totalRows': 0,
            'successCount': 0,
            'failedCount': 0,
            'processedRanges': [],
            'skipped': True,
        }
        self.write({
            'job_skip_file': '',
            'file_progress': json.dumps(file_progress),
        })
        self.env.cr.commit()

    def _get_attachment_by_name(self, filename):
        """Find attachment by filename from the log's attached files."""
        for att in self.attachment_ids:
            if att.name == filename:
                return att
        return None

    def _get_resume_rows(self, filename, all_rows, file_progress):
        """
        For resume: compute which rows still need processing.
        Returns filtered rows or None if not resuming.
        """
        if filename not in file_progress:
            return None

        fp = file_progress[filename]
        if fp.get('skipped'):
            return []

        processed_ranges = fp.get('processedRanges', [])
        total_rows = fp.get('totalRows', 0)

        if not processed_ranges and not total_rows:
            return None

        # Compute pending indices (not in any processed range)
        processed = set()
        for start, end in processed_ranges:
            for i in range(start, end + 1):
                processed.add(i)

        # Get failed row indices from file_progress (not error_log,
        # which may be truncated during periodic progress commits).
        failed_indices = set(fp.get('failedIndices', []))

        # Union of pending + failed
        target_indices = set()
        for row in all_rows:
            if row.index not in processed or row.index in failed_indices:
                target_indices.add(row.index)

        if not target_indices:
            return []

        return [row for row in all_rows if row.index in target_indices]

    def _process_retries(self, filename, importer, all_rows, file_errors, settings):
        """Retry failed rows up to retryLimit times. Returns list of retry results."""
        max_retries = settings.get('retryLimit', 3)
        retry_delay = settings.get('retryDelayMs', 500) / 1000.0

        remaining_errors = list(file_errors)
        all_retry_results = []

        for attempt in range(max_retries):
            failed_indices = {e['rowNumber'] for e in remaining_errors if e.get('rowNumber', 0) > 0}
            if not failed_indices:
                break

            retry_rows = [r for r in all_rows if r.index in failed_indices]
            if not retry_rows:
                break

            if retry_delay > 0:
                time.sleep(retry_delay)

            if self._is_cancelled():
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

    def _commit_file_progress(self, filename, file_progress, processed_indices,
                               total_rows, file_success, file_failed,
                               all_success, all_failed, all_errors):
        """Commit current progress to DB so Vue can poll it."""
        # Store failed indices per file so resume can find them even when
        # error_log is truncated for polling.
        failed_indices = sorted({
            e['rowNumber'] for e in all_errors
            if e.get('filename') == filename and e.get('rowNumber', 0) > 0
        })
        file_progress[filename] = {
            'totalRows': total_rows,
            'successCount': file_success,
            'failedCount': file_failed,
            'processedRanges': self._indices_to_ranges(processed_indices),
            'failedIndices': failed_indices,
        }
        self.write({
            'success_rows': all_success,
            'failed_rows': all_failed,
            'file_progress': json.dumps(file_progress),
            'error_log': json.dumps(all_errors[-100:]),  # Keep last 100 for polling
            'heartbeat': fields.Datetime.now(),
        })
        self.env.cr.commit()

    @staticmethod
    def _indices_to_ranges(indices):
        """Convert a set of indices to sorted [start, end] ranges."""
        if not indices:
            return []
        sorted_idx = sorted(indices)
        ranges = []
        start = sorted_idx[0]
        end = sorted_idx[0]
        for i in sorted_idx[1:]:
            if i == end + 1:
                end = i
            else:
                ranges.append([start, end])
                start = i
                end = i
        ranges.append([start, end])
        return ranges

    def _create_retry_log(self):
        """Create a new log record for retrying failed rows from this log."""
        self.ensure_one()
        error_log = json.loads(self.error_log or '[]')
        failed_filenames = list({e['filename'] for e in error_log if e.get('rowNumber', 0) > 0})
        total_failed = sum(1 for e in error_log if e.get('rowNumber', 0) > 0)

        return self.create({
            'profile_name': self.profile_name,
            'profile_id': self.profile_id.id if self.profile_id else False,
            'is_dry_run': self.is_dry_run,
            'attachment_ids': [(6, 0, self.attachment_ids.ids)],
            'filenames': json.dumps(failed_filenames),
            'total_rows': total_failed,
            'job_config': self.job_config,
            'file_progress': self.file_progress,  # Contains processed ranges for resume
            'error_log': self.error_log,  # Contains failed row indices
        })

    @api.model
    def _cron_detect_stale_logs(self):
        """Find logs that are still 'running' but haven't sent a heartbeat
        in over 2 hours — mark them as 'interrupted'."""
        cutoff = fields.Datetime.subtract(fields.Datetime.now(), hours=2)
        stale = self.search([
            ('state', '=', 'running'),
            '|',
            ('heartbeat', '<', cutoff),
            ('heartbeat', '=', False),
        ])
        if stale:
            _logger.info("Marking %d stale import logs as interrupted", len(stale))
            stale.write({
                'state': 'interrupted',
                'finished_at': fields.Datetime.now(),
            })

    @api.model
    def _cron_cleanup_attachments(self, retention_days=7):
        """Delete attachments from completed/failed logs older than retention_days.
        Also clean up orphaned import attachments."""
        cutoff = fields.Datetime.subtract(fields.Datetime.now(), days=retention_days)

        # 1. Logs with attachments that are old and finished
        old_logs = self.search([
            ('state', 'in', ['completed', 'failed']),
            ('finished_at', '<', cutoff),
        ])
        for log in old_logs:
            if log.attachment_ids:
                _logger.info(
                    "Cleaning up %d attachments from log #%d",
                    len(log.attachment_ids), log.id,
                )
                attachments = log.attachment_ids
                log.write({'attachment_ids': [(5, 0, 0)]})
                attachments.unlink()

        # 2. Orphaned attachments (res_model = 'ametras_fast_import.file', res_id = 0)
        orphans = self.env['ir.attachment'].search([
            ('res_model', '=', 'ametras_fast_import.file'),
            ('res_id', '=', 0),
            ('create_date', '<', cutoff),
        ])
        # Exclude those linked to any log
        if orphans:
            linked = self.env['ir.attachment'].search([
                ('id', 'in', orphans.ids),
                ('csv_import_log_attachment_rel.log_id', '!=', False),
            ])
            to_delete = orphans - linked
            if to_delete:
                _logger.info("Deleting %d orphaned import attachments", len(to_delete))
                to_delete.unlink()
