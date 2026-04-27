import csv
import io
import json
import logging

from odoo import fields, http
from odoo.http import request

_logger = logging.getLogger(__name__)


def _parse_datetime(value):
    """Convert ISO 8601 datetime string to Odoo format.

    JavaScript's Date.toISOString() produces "2026-03-02T17:07:23.797Z"
    but Odoo 16 expects "2026-03-02 17:07:23".
    """
    if not value:
        return False
    if not isinstance(value, str):
        return value
    # Replace T separator with space
    value = value.replace("T", " ")
    # Strip milliseconds (.797) and timezone suffix (Z)
    if "." in value:
        value = value[: value.index(".")]
    if value.endswith("Z"):
        value = value[:-1]
    return value


class LogController(http.Controller):
    @http.route(
        "/ametras_fast_import/log/save", type="json", auth="user", methods=["POST"]
    )
    def save_log(self, **kwargs):
        """Save a completed import log (legacy endpoint — kept for backward compat)."""
        vals = {
            "profile_name": kwargs.get("profile_name", ""),
            "is_dry_run": bool(kwargs.get("is_dry_run", False)),
            "state": kwargs.get("state", "completed"),
            "started_at": _parse_datetime(kwargs.get("started_at"))
            or fields.Datetime.now(),
            "finished_at": _parse_datetime(kwargs.get("finished_at"))
            or fields.Datetime.now(),
            "filenames": json.dumps(kwargs.get("filenames", [])),
            "total_rows": kwargs.get("total_rows", 0),
            "success_rows": kwargs.get("success_rows", 0),
            "failed_rows": kwargs.get("failed_rows", 0),
            "error_log": json.dumps(kwargs.get("error_log", [])),
        }

        profile_id = kwargs.get("profile_id")
        if profile_id:
            # Verify the profile exists
            profile = request.env["csv.import.profile"].browse(int(profile_id)).exists()
            if profile:
                vals["profile_id"] = profile.id

        record = request.env["csv.import.log"].create(vals)
        return {"ok": True, "id": record.id}

    @http.route(
        "/ametras_fast_import/log/create", type="json", auth="user", methods=["POST"]
    )
    def create_log(self, **kwargs):
        """Create a log record at import start (state='running')."""
        vals = {
            "profile_name": kwargs.get("profile_name", ""),
            "is_dry_run": bool(kwargs.get("is_dry_run", False)),
            "state": "running",
            "started_at": _parse_datetime(kwargs.get("started_at"))
            or fields.Datetime.now(),
            "filenames": json.dumps(kwargs.get("filenames", [])),
            "total_rows": kwargs.get("total_rows", 0),
            "success_rows": 0,
            "failed_rows": 0,
            "heartbeat": fields.Datetime.now(),
            "file_progress": json.dumps(kwargs.get("file_progress", {})),
        }

        profile_id = kwargs.get("profile_id")
        if profile_id:
            profile = request.env["csv.import.profile"].browse(int(profile_id)).exists()
            if profile:
                vals["profile_id"] = profile.id

        # Link attachment IDs if provided
        attachment_ids = kwargs.get("attachment_ids", [])
        if attachment_ids:
            vals["attachment_ids"] = [(6, 0, attachment_ids)]

        record = request.env["csv.import.log"].create(vals)
        return {"ok": True, "id": record.id}

    @http.route(
        "/ametras_fast_import/log/update", type="json", auth="user", methods=["POST"]
    )
    def update_log(self, **kwargs):
        """Heartbeat + progress update during import."""
        log_id = kwargs.get("log_id")
        if not log_id:
            return {"ok": False, "error": "log_id required"}

        log = request.env["csv.import.log"].browse(int(log_id)).exists()
        if not log:
            return {"ok": False, "error": "Log not found"}

        vals = {"heartbeat": fields.Datetime.now()}

        if "success_rows" in kwargs:
            vals["success_rows"] = kwargs["success_rows"]
        if "failed_rows" in kwargs:
            vals["failed_rows"] = kwargs["failed_rows"]
        if "file_progress" in kwargs:
            vals["file_progress"] = json.dumps(kwargs["file_progress"])

        log.write(vals)
        return {"ok": True}

    @http.route(
        "/ametras_fast_import/log/finalize", type="json", auth="user", methods=["POST"]
    )
    def finalize_log(self, **kwargs):
        """Set final state, finished_at, final counts, error_log."""
        log_id = kwargs.get("log_id")
        if not log_id:
            return {"ok": False, "error": "log_id required"}

        log = request.env["csv.import.log"].browse(int(log_id)).exists()
        if not log:
            return {"ok": False, "error": "Log not found"}

        vals = {
            "state": kwargs.get("state", "completed"),
            "finished_at": _parse_datetime(kwargs.get("finished_at"))
            or fields.Datetime.now(),
            "heartbeat": fields.Datetime.now(),
        }

        if "total_rows" in kwargs:
            vals["total_rows"] = kwargs["total_rows"]
        if "success_rows" in kwargs:
            vals["success_rows"] = kwargs["success_rows"]
        if "failed_rows" in kwargs:
            vals["failed_rows"] = kwargs["failed_rows"]
        if "error_log" in kwargs:
            vals["error_log"] = json.dumps(kwargs["error_log"])
        if "file_progress" in kwargs:
            vals["file_progress"] = json.dumps(kwargs["file_progress"])

        log.write(vals)
        return {"ok": True}

    @http.route(
        "/ametras_fast_import/log/get", type="json", auth="user", methods=["POST"]
    )
    def get_log(self, **kwargs):
        """Get full log details for resume."""
        log_id = kwargs.get("log_id")
        if not log_id:
            return {"ok": False, "error": "log_id required"}

        log = request.env["csv.import.log"].browse(int(log_id)).exists()
        if not log:
            return {"ok": False, "error": "Log not found"}

        return {
            "ok": True,
            "log": {
                "id": log.id,
                "profile_name": log.profile_name or "",
                "profile_id": log.profile_id.id if log.profile_id else None,
                "user_id": log.user_id.id,
                "is_dry_run": log.is_dry_run,
                "state": log.state,
                "started_at": log.started_at.isoformat() if log.started_at else None,
                "finished_at": log.finished_at.isoformat() if log.finished_at else None,
                "duration_seconds": log.duration_seconds,
                "filenames": json.loads(log.filenames or "[]"),
                "total_rows": log.total_rows,
                "success_rows": log.success_rows,
                "failed_rows": log.failed_rows,
                "pending_rows": log.pending_rows,
                "file_progress": json.loads(log.file_progress or "{}"),
                "error_log": json.loads(log.error_log or "[]"),
                "attachment_ids": log.attachment_ids.ids,
            },
        }

    @http.route(
        "/ametras_fast_import/log/list", type="json", auth="user", methods=["POST"]
    )
    def list_logs(self, **kwargs):
        """List recent import logs."""
        limit = kwargs.get("limit", 50)
        offset = kwargs.get("offset", 0)

        logs = request.env["csv.import.log"].search(
            [], limit=limit, offset=offset, order="create_date desc"
        )

        result = []
        for log in logs:
            result.append(
                {
                    "id": log.id,
                    "profile_name": log.profile_name or "",
                    "profile_id": log.profile_id.id if log.profile_id else None,
                    "user_id": log.user_id.id,
                    "user_name": log.user_id.name,
                    "is_dry_run": log.is_dry_run,
                    "state": log.state,
                    "started_at": log.started_at.isoformat()
                    if log.started_at
                    else None,
                    "finished_at": log.finished_at.isoformat()
                    if log.finished_at
                    else None,
                    "duration_seconds": log.duration_seconds,
                    "filenames": json.loads(log.filenames or "[]"),
                    "total_rows": log.total_rows,
                    "success_rows": log.success_rows,
                    "failed_rows": log.failed_rows,
                    "pending_rows": log.pending_rows,
                    "error_log": json.loads(log.error_log or "[]"),
                    "create_date": log.create_date.isoformat()
                    if log.create_date
                    else None,
                }
            )

        return result

    @http.route(
        "/ametras_fast_import/log/<int:log_id>/error_csv",
        type="http",
        auth="user",
        methods=["GET"],
    )
    def download_error_csv(self, log_id, **kwargs):
        """Download the error log as a CSV file."""
        log = request.env["csv.import.log"].browse(log_id).exists()
        if not log:
            return request.not_found()

        errors = json.loads(log.error_log or "[]")

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["Filename", "Row Number", "Error"])
        for entry in errors:
            writer.writerow(
                [
                    entry.get("filename", ""),
                    entry.get("rowNumber", ""),
                    entry.get("error", ""),
                ]
            )

        content = output.getvalue()
        return request.make_response(
            content,
            headers=[
                ("Content-Type", "text/csv; charset=utf-8"),
                (
                    "Content-Disposition",
                    f'attachment; filename="import_errors_{log_id}.csv"',
                ),
            ],
        )
