import json
import logging

from odoo import api, fields, models

from .import_engine.constants import STALE_JOB_CUTOFF_HOURS

_logger = logging.getLogger(__name__)


class CsvImportLog(models.Model):
    _name = "csv.import.log"
    _description = "CSV Import Log"
    _order = "create_date desc"

    # Metadata
    profile_name = fields.Char(string="Profile")
    profile_id = fields.Many2one(
        "csv.import.profile", string="Profile Record", ondelete="set null"
    )
    user_id = fields.Many2one(
        "res.users", string="User", default=lambda self: self.env.user, required=True
    )
    is_dry_run = fields.Boolean(string="Dry Run", default=False)
    state = fields.Selection(
        [
            ("running", "Running"),
            ("completed", "Completed"),
            ("failed", "Failed"),
            ("interrupted", "Interrupted"),
        ],
        string="State",
        default="running",
    )

    # Job execution
    job_config = fields.Text(string="Job Config (JSON)", default="{}")
    job_state = fields.Selection(
        [
            ("draft", "Draft"),
            ("pending", "Pending"),
            ("running", "Running"),
            ("paused", "Paused"),
            ("completed", "Completed"),
            ("failed", "Failed"),
            ("interrupted", "Interrupted"),
        ],
        string="Job State",
        default="draft",
    )
    job_cancel_requested = fields.Boolean(default=False)
    job_pause_requested = fields.Boolean(default=False)
    job_skip_file = fields.Char(string="File to Skip", default="")
    current_file = fields.Char(string="Current File", default="")

    # Timing
    started_at = fields.Datetime(string="Started", required=True)
    finished_at = fields.Datetime(string="Finished")
    duration_seconds = fields.Integer(
        string="Duration (s)", compute="_compute_duration", store=True
    )
    heartbeat = fields.Datetime(string="Last Heartbeat")

    # Files
    filenames = fields.Text(string="Filenames (JSON)", default="[]")
    attachment_ids = fields.Many2many(
        "ir.attachment",
        "csv_import_log_attachment_rel",
        "log_id",
        "attachment_id",
        string="Import Files",
    )

    # Results
    total_rows = fields.Integer(string="Total Rows")
    success_rows = fields.Integer(string="Successful")
    failed_rows = fields.Integer(string="Failed")
    pending_rows = fields.Integer(
        string="Pending",
        compute="_compute_pending_rows",
        store=True,
    )

    # Progress tracking (JSON: per-file processed ranges + counts)
    file_progress = fields.Text(string="File Progress (JSON)", default="{}")

    # Error log
    error_log = fields.Text(string="Error Log (JSON)", default="[]")

    @api.depends("started_at", "finished_at")
    def _compute_duration(self):
        for rec in self:
            if rec.started_at and rec.finished_at:
                delta = rec.finished_at - rec.started_at
                rec.duration_seconds = int(delta.total_seconds())
            else:
                rec.duration_seconds = 0

    @api.depends("total_rows", "success_rows", "failed_rows")
    def _compute_pending_rows(self):
        for rec in self:
            rec.pending_rows = max(
                0, rec.total_rows - rec.success_rows - rec.failed_rows
            )

    # ------------------------------------------------------------------
    # Actions — open Vue dialogs
    # ------------------------------------------------------------------

    @api.model
    def action_start_new_import(self):
        """Open the import wizard in a dialog."""
        return {
            "type": "ir.actions.client",
            "tag": "ametras_csv_import_vue_app",
            "name": "Ametras Fast Import",
            "target": "new",
            "params": {"default_view": "import"},
            "context": {"dialog_size": "extra-large"},
        }

    def action_open_log(self):
        """Open the appropriate Vue view based on log state."""
        self.ensure_one()
        params = {}
        if self.state == "running":
            params.update(default_view="run", resume_log_id=self.id)
        elif self.state in ("completed", "failed"):
            params.update(default_view="results", log_id=self.id)
        elif self.state == "interrupted":
            params.update(default_view="import", resume_log_id=self.id)
        else:
            params["default_view"] = "import"
        return {
            "type": "ir.actions.client",
            "tag": "ametras_csv_import_vue_app",
            "name": "Import",
            "target": "new",
            "params": params,
            "context": {"dialog_size": "extra-large"},
        }

    def action_retry_failed(self):
        """Open the Import client action for retrying failed rows."""
        self.ensure_one()
        return {
            "type": "ir.actions.client",
            "tag": "ametras_csv_import_vue_app",
            "name": "Retry Import",
            "params": {
                "default_view": "import",
                "retry_log_id": self.id,
            },
        }

    def action_resume_import(self):
        """Open Import Vue app with context to resume this import."""
        self.ensure_one()
        return {
            "type": "ir.actions.client",
            "tag": "ametras_csv_import_vue_app",
            "name": "Resume Import",
            "params": {
                "default_view": "import",
                "resume_log_id": self.id,
            },
        }

    def action_download_errors(self):
        """Download error log as CSV file."""
        self.ensure_one()
        return {
            "type": "ir.actions.act_url",
            "url": f"/ametras_fast_import/log/{self.id}/error_csv",
            "target": "self",
        }

    # ------------------------------------------------------------------
    # Job execution
    # ------------------------------------------------------------------

    def action_start_import(self):
        """Enqueue a background import job via queue_job."""
        self.ensure_one()
        self.write(
            {
                "job_state": "pending",
                "state": "running",
                "started_at": fields.Datetime.now(),
                "job_cancel_requested": False,
                "job_pause_requested": False,
                "job_skip_file": "",
            }
        )
        self.with_delay(
            channel="root.csv_import",
            description=f"CSV Import: {self.profile_name or self.id}",
            max_retries=0,
        )._execute_import()

    def _execute_import(self):
        """Run the full import. Executed by the queue_job worker."""
        from .import_job import ImportJob

        ImportJob(self).run()

    def _create_resume_log(self):
        """Create a new log record for resuming/retrying failed rows from this log."""
        self.ensure_one()
        error_log = json.loads(self.error_log or "[]")
        failed_filenames = list(
            {e["filename"] for e in error_log if e.get("rowNumber", 0) > 0}
        )
        total_failed = sum(1 for e in error_log if e.get("rowNumber", 0) > 0)

        return self.create(
            {
                "profile_name": self.profile_name,
                "profile_id": self.profile_id.id if self.profile_id else False,
                "is_dry_run": self.is_dry_run,
                # started_at is required; action_start_import() overwrites it when
                # the job is actually enqueued, but the create must satisfy the
                # constraint first (otherwise retry fails immediately).
                "started_at": fields.Datetime.now(),
                "attachment_ids": [(6, 0, self.attachment_ids.ids)],
                "filenames": json.dumps(failed_filenames),
                "total_rows": total_failed,
                "job_config": self.job_config,
                "file_progress": self.file_progress,  # processed ranges for resume
                "error_log": self.error_log,  # failed row indices for resume
            }
        )

    # ------------------------------------------------------------------
    # Cron jobs
    # ------------------------------------------------------------------

    @api.model
    def _cron_detect_stale_logs(self):
        """Mark logs still 'running' without a heartbeat in 2+ hours as interrupted."""
        cutoff = fields.Datetime.subtract(
            fields.Datetime.now(), hours=STALE_JOB_CUTOFF_HOURS
        )
        stale = self.search(
            [
                ("state", "=", "running"),
                "|",
                ("heartbeat", "<", cutoff),
                ("heartbeat", "=", False),
            ]
        )
        if stale:
            _logger.info("Marking %d stale import logs as interrupted", len(stale))
            stale.write(
                {
                    "state": "interrupted",
                    "finished_at": fields.Datetime.now(),
                }
            )

    @api.model
    def _cron_cleanup_attachments(self, retention_days=7):
        """Delete attachments from completed/failed logs older than retention_days."""
        cutoff = fields.Datetime.subtract(fields.Datetime.now(), days=retention_days)

        old_logs = self.search(
            [
                ("state", "in", ["completed", "failed"]),
                ("finished_at", "<", cutoff),
            ]
        )
        for log in old_logs:
            if log.attachment_ids:
                _logger.info(
                    "Cleaning up %d attachments from log #%d",
                    len(log.attachment_ids),
                    log.id,
                )
                attachments = log.attachment_ids
                log.write({"attachment_ids": [(5, 0, 0)]})
                attachments.unlink()

        # Orphaned upload attachments: uploaded files older than the cutoff that
        # were never attached to any import log (e.g. the user opened the import
        # dialog, dropped files, then closed it without starting). These have
        # res_id=0 and no row in the log<->attachment relation.
        orphans = self.env["ir.attachment"].search(
            [
                ("res_model", "=", "ametras_fast_import.file"),
                ("res_id", "=", 0),
                ("create_date", "<", cutoff),
            ]
        )
        if orphans:
            # ir.attachment has no reverse field for the m2m, so resolve the
            # link from the log side: any of these attachments referenced by a
            # log must be kept (its lifecycle is handled by the branch above).
            linked_ids = (
                self.search([("attachment_ids", "in", orphans.ids)])
                .mapped("attachment_ids")
                .ids
            )
            to_delete = orphans.filtered(lambda a: a.id not in linked_ids)
            if to_delete:
                _logger.info("Deleting %d orphaned import attachments", len(to_delete))
                to_delete.unlink()
