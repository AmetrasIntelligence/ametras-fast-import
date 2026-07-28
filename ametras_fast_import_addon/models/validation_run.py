"""
Post-import validation runner (server side).

Re-runs, per file, the same transform -> resolve -> record-lookup the import
used and reads the resulting records back to confirm the database actually holds
what was intended (see import_engine/validator.py). Read-only. Rows that failed
the original import (tracked in file_progress.failedIndices) are excluded so the
report reflects only rows believed to have imported.

Mirrors ImportJob's per-file setup (job_config, attachments, parse options) but
never writes. Runs inside a queue_job worker via csv.import.log._execute_validation.
"""
import base64
import json
import logging

from .import_engine.constants import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_DELIMITER,
    DEFAULT_ENCODING,
    MAX_BATCH_SIZE,
    MIN_BATCH_SIZE,
)
from .import_engine.importer import ImportConfig, Importer
from .import_engine.parser import ParseOptions, parse_csv_file, parse_csv_string
from .import_engine.validator import ValidationReport
from .orm_backend import OrmBackend

_logger = logging.getLogger(__name__)

# Bound the number of mismatch/unvalidatable detail entries persisted per file so
# a pathological import can't bloat the log; totals are always exact.
MAX_DETAIL_ENTRIES = 2000


class ValidationRunner:
    def __init__(self, log):
        self.log = log
        self.env = log.env

    def run(self) -> dict:
        config = json.loads(self.log.job_config or "{}")
        settings = config.get("settings", {})
        lang = settings.get("lang")
        env = self.log.with_context(lang=lang).env if lang else self.env
        backend = OrmBackend(env)

        encoding = settings.get("encoding", DEFAULT_ENCODING)
        delimiter = settings.get("delimiter", DEFAULT_DELIMITER)
        batch_size = max(
            MIN_BATCH_SIZE,
            min(MAX_BATCH_SIZE, settings.get("batchSize", DEFAULT_BATCH_SIZE)),
        )
        options = ParseOptions(delimiter=delimiter, encoding=encoding, has_header=True)

        file_progress = json.loads(self.log.file_progress or "{}")
        import_sequence = config.get("importSequence", [])
        file_mappings = config.get("fileMappings", {})

        per_file: dict[str, dict] = {}
        totals = {"checked": 0, "ok": 0, "failedRows": 0, "unvalidatable": 0}

        # Files we will actually validate (have a mapping + an attachment) — the
        # denominator for progress reporting.
        todo = [
            fn
            for fn in import_sequence
            if file_mappings.get(fn, {}).get("model")
            and self._get_attachment_by_name(fn)
        ]
        files_total = len(todo)
        files_done = 0

        for filename in todo:
            file_mapping = file_mappings[filename]
            attachment = self._get_attachment_by_name(filename)

            failed_indices = set(
                file_progress.get(filename, {}).get("failedIndices", [])
            )
            field_mappings = file_mapping.get("fieldMappings", {})
            import_config = ImportConfig(
                model=file_mapping["model"],
                field_mappings=field_mappings,
                use_external_id=bool("id" in field_mappings.values()),
                search_keys=file_mapping.get("searchKeys"),
            )
            importer = Importer(backend, import_config)

            report = ValidationReport(model=import_config.model)
            for batch in self._iter_row_batches(attachment, options, batch_size):
                rows = [r for r in batch if r.index not in failed_indices]
                if rows:
                    report.merge(importer.validate_rows(rows))

            rd = report.to_dict()
            # Bound persisted detail; totals stay exact.
            rd["mismatches"] = rd["mismatches"][:MAX_DETAIL_ENTRIES]
            rd["unvalidatable"] = rd["unvalidatable"][:MAX_DETAIL_ENTRIES]
            per_file[filename] = rd

            totals["checked"] += report.checked
            totals["ok"] += report.ok
            totals["failedRows"] += rd["failedRows"]
            totals["unvalidatable"] += len(report.unvalidatable)
            files_done += 1

            # Persist partial progress so the UI poll can show "file X of Y"
            # instead of an opaque spinner. State stays "running" until the
            # queue-job wrapper writes the terminal passed/failed.
            self.log.write(
                {
                    "validation_result": json.dumps(
                        {
                            **totals,
                            "perFile": dict(per_file),
                            "progress": {
                                "filesDone": files_done,
                                "filesTotal": files_total,
                                "currentFile": filename,
                            },
                        }
                    )
                }
            )
            self.env.cr.commit()

        return {
            **totals,
            "perFile": per_file,
            "progress": {"filesDone": files_done, "filesTotal": files_total},
        }

    # -- helpers (mirror ImportJob) ------------------------------------------

    def _get_attachment_by_name(self, filename):
        return self.env["ir.attachment"].search(
            [("id", "in", self.log.attachment_ids.ids), ("name", "=", filename)],
            limit=1,
        )

    def _iter_row_batches(self, attachment, options, batch_size):
        """Yield lists of ParsedRow, streaming from disk when possible."""
        file_path = (
            attachment._full_path(attachment.store_fname)
            if attachment.store_fname
            else None
        )
        if file_path:
            source = parse_csv_file(file_path, options)
        else:
            content = base64.b64decode(attachment.datas).decode(
                options.encoding, errors="replace"
            )
            source = parse_csv_string(content, options)

        batch = []
        for row in source:
            batch.append(row)
            if len(batch) >= batch_size:
                yield batch
                batch = []
        if batch:
            yield batch
