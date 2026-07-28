"""
Entry point for Electron subprocess mode.

Usage:
    python -m import_engine

Reads JSON commands from stdin (one per line), executes them,
and writes results as JSON lines to stdout.
"""
from __future__ import annotations

import json
import logging
import queue
import sys
import threading

from .backend import RpcBackend
from .constants import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_DELIMITER,
    DEFAULT_ENCODING,
    DEFAULT_WORKERS,
    MAX_RESPONSE_ERRORS_BATCH_MODE,
    MAX_RESPONSE_ERRORS_FILE_MODE,
    MODEL_IR_MODEL,
    PROGRESS_TYPE_ANALYSIS,
    PROGRESS_TYPE_AUTH_OK,
    PROGRESS_TYPE_CANCELLED,
    PROGRESS_TYPE_ERROR,
    PROGRESS_TYPE_FIELDS,
    PROGRESS_TYPE_MODELS,
    PROGRESS_TYPE_PONG,
    PROGRESS_TYPE_VALIDATION,
)
from .importer import ImportConfig, Importer, ImportFileSummary
from .parser import ParsedRow, ParseOptions, analyze_csv_file, parse_csv_file
from .progress import JsonLinesReporter, ProgressReporter
from .validator import ValidationReport

# Route logs to stderr so they don't interfere with the JSON protocol on stdout
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(levelname)s %(name)s: %(message)s",
)

_logger = logging.getLogger(__name__)

# Global reference to current importer and cancel event for cancel support
_current_importer: Importer | None = None
_current_cancel_event: threading.Event | None = None


def _emit(data: dict) -> None:
    """Write a JSON line to stdout."""
    sys.stdout.write(json.dumps(data, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _get_backend(
    cmd: dict,
    cancel_event: threading.Event | None = None,
    reporter: ProgressReporter | None = None,
    lang: str | None = None,
) -> RpcBackend:
    """Create RpcBackend from command credentials. Reuses uid if provided."""
    if "uid" in cmd:
        return RpcBackend(
            cmd["url"],
            cmd["db"],
            cmd["uid"],
            cmd["password"],
            cancel_event=cancel_event,
            reporter=reporter,
            lang=lang,
        )
    backend = RpcBackend.authenticate(
        cmd["url"], cmd["db"], cmd["login"], cmd["password"]
    )
    backend._cancel_event = cancel_event
    backend._reporter = reporter or backend._reporter
    backend.lang = lang
    return backend


def _handle_authenticate(cmd: dict) -> None:
    """Authenticate with Odoo and return uid."""
    try:
        backend = RpcBackend.authenticate(
            cmd["url"], cmd["db"], cmd["login"], cmd["password"]
        )
        _emit({"type": PROGRESS_TYPE_AUTH_OK, "uid": backend.uid})
    except Exception as e:
        _emit({"type": PROGRESS_TYPE_ERROR, "message": str(e)})


def _handle_import(cmd: dict) -> None:
    """Run a CSV import."""
    global _current_importer
    reporter = JsonLinesReporter()
    cancel_event = threading.Event()

    try:
        backend = _get_backend(
            cmd, cancel_event=cancel_event, reporter=reporter, lang=cmd.get("lang")
        )

        config = ImportConfig(
            model=cmd["model"],
            field_mappings=cmd.get("field_mappings", {}),
            use_external_id=cmd.get("use_external_id", False),
            search_keys=cmd.get("search_keys"),
            dry_run=cmd.get("dry_run", False),
            strict=cmd.get("strict", False),
            batch_size=cmd.get("batch_size", DEFAULT_BATCH_SIZE),
        )

        options = ParseOptions(
            delimiter=cmd.get("delimiter", DEFAULT_DELIMITER),
            encoding=cmd.get("encoding", DEFAULT_ENCODING),
            has_header=cmd.get("has_header", True),
        )

        importer = Importer(backend, config, reporter)
        _current_importer = importer

        workers = cmd.get("workers", DEFAULT_WORKERS)

        # Mode 1: raw_rows (batch from Vue via IPC)
        raw_rows = cmd.get("raw_rows")
        if raw_rows is not None:
            # Use original row indices if provided (retry mode), else 1-based
            row_indices = cmd.get("row_indices")
            if row_indices and len(row_indices) == len(raw_rows):
                parsed = [
                    ParsedRow(index=idx, data=row)
                    for idx, row in zip(row_indices, raw_rows, strict=False)
                ]
            else:
                parsed = [
                    ParsedRow(index=i + 1, data=row) for i, row in enumerate(raw_rows)
                ]
            results = importer.import_rows(parsed)

            all_success = sum(1 for r in results if r.ok)
            all_failed = sum(1 for r in results if not r.ok)
            all_errors = [
                {"row": r.row_index, "error": r.error} for r in results if not r.ok
            ]
            reporter.import_completed(
                {
                    "success": all_success,
                    "failed": all_failed,
                    "errors": all_errors[:MAX_RESPONSE_ERRORS_BATCH_MODE],
                    "total_errors": len(all_errors),
                }
            )
            return

        # Mode 2: file_path(s) (full CSV import from disk)
        file_paths = cmd.get("file_paths", [])
        if "file_path" in cmd:
            file_paths = [cmd["file_path"]]

        all_success = 0
        all_failed = 0
        all_errors: list[dict] = []

        for file_path in file_paths:
            summary: ImportFileSummary = importer.import_csv_file(
                file_path, options, workers=workers
            )
            if summary.file_error:
                # Whole-file error already emitted via reporter.error(); skip stats.
                continue
            all_success += summary.success
            all_failed += summary.failed
            all_errors.extend(
                {"row": r.row_index, "error": r.error, "file": file_path}
                for r in summary.errors
            )

        # Limit errors sent back to prevent stdout overflow on large imports.
        # The full error list can be massive (10k+ entries × 200 bytes each).
        reporter.import_completed(
            {
                "success": all_success,
                "failed": all_failed,
                "errors": all_errors[:MAX_RESPONSE_ERRORS_FILE_MODE],
                "total_errors": len(all_errors),
            }
        )

    except Exception as e:
        _logger.exception("Import failed")
        reporter.error(str(e))
    finally:
        _current_importer = None


def _handle_validate(cmd: dict) -> None:
    """Read imported records back and verify they match the file (no writes).

    Mirrors _handle_import's input (raw_rows or file_path(s) + model +
    field_mappings + credentials) but only reads, emitting a single validation
    report. Used by the standalone client's "Validate Import" button.
    """
    try:
        backend = _get_backend(cmd, lang=cmd.get("lang"))
        config = ImportConfig(
            model=cmd["model"],
            field_mappings=cmd.get("field_mappings", {}),
            use_external_id=cmd.get("use_external_id", False),
            search_keys=cmd.get("search_keys"),
        )
        options = ParseOptions(
            delimiter=cmd.get("delimiter", DEFAULT_DELIMITER),
            encoding=cmd.get("encoding", DEFAULT_ENCODING),
            has_header=cmd.get("has_header", True),
        )
        importer = Importer(backend, config)
        report = ValidationReport(model=config.model)

        # Rows that failed the original import are excluded so validation
        # reflects only rows believed to have imported (parity with the
        # embedded ValidationRunner, which uses file_progress.failedIndices).
        skip_indices = set(cmd.get("skip_indices") or [])

        raw_rows = cmd.get("raw_rows")
        if raw_rows is not None:
            row_indices = cmd.get("row_indices")
            if row_indices and len(row_indices) == len(raw_rows):
                parsed = [
                    ParsedRow(index=idx, data=row)
                    for idx, row in zip(row_indices, raw_rows, strict=False)
                ]
            else:
                parsed = [
                    ParsedRow(index=i + 1, data=row) for i, row in enumerate(raw_rows)
                ]
            parsed = [r for r in parsed if r.index not in skip_indices]
            report.merge(importer.validate_rows(parsed))
        else:
            file_paths = cmd.get("file_paths", [])
            if "file_path" in cmd:
                file_paths = [cmd["file_path"]]
            for file_path in file_paths:
                rows = [
                    r
                    for r in parse_csv_file(file_path, options)
                    if r.index not in skip_indices
                ]
                report.merge(importer.validate_rows(rows))

        result = report.to_dict()
        result["mismatches"] = result["mismatches"][:MAX_RESPONSE_ERRORS_FILE_MODE]
        result["unvalidatable"] = result["unvalidatable"][
            :MAX_RESPONSE_ERRORS_FILE_MODE
        ]
        _emit({"type": PROGRESS_TYPE_VALIDATION, "report": result})
    except Exception as e:
        _logger.exception("Validation failed")
        _emit({"type": PROGRESS_TYPE_ERROR, "message": str(e)})


def _handle_models(cmd: dict) -> None:
    """List importable models (for model selection dropdown)."""
    try:
        backend = _get_backend(cmd)
        models = backend.search_read(
            MODEL_IR_MODEL,
            [("transient", "=", False)],
            ["model", "name"],
        )
        _emit(
            {
                "type": PROGRESS_TYPE_MODELS,
                "models": [{"model": m["model"], "name": m["name"]} for m in models],
            }
        )
    except Exception as e:
        _emit({"type": PROGRESS_TYPE_ERROR, "message": str(e)})


def _handle_fields(cmd: dict) -> None:
    """Get field info for a model (for field mapping UI)."""
    try:
        backend = _get_backend(cmd)
        field_info = backend.get_field_info(cmd["model"])
        _emit(
            {
                "type": PROGRESS_TYPE_FIELDS,
                "fields": {
                    name: {
                        "name": fi.name,
                        "type": fi.type,
                        "comodel_name": fi.comodel_name,
                    }
                    for name, fi in field_info.items()
                },
            }
        )
    except Exception as e:
        _emit({"type": PROGRESS_TYPE_ERROR, "message": str(e)})


def _handle_analyze(cmd: dict) -> None:
    """Analyze a CSV file (headers, delimiter, sample rows, row count)."""
    try:
        result = analyze_csv_file(
            cmd["file_path"],
            encoding=cmd.get("encoding", DEFAULT_ENCODING),
            delimiter=cmd.get("delimiter", ""),
        )
        _emit({"type": PROGRESS_TYPE_ANALYSIS, **result})
    except Exception as e:
        _emit({"type": PROGRESS_TYPE_ERROR, "message": str(e)})


def _handle_cancel(_cmd: dict) -> None:
    """Cancel the currently running import."""
    if _current_importer:
        _current_importer.cancel()
        # Also signal the backend's reconnect wait loop to stop immediately
        if _current_cancel_event:
            _current_cancel_event.set()
        _emit({"type": PROGRESS_TYPE_CANCELLED})
    else:
        _emit({"type": PROGRESS_TYPE_ERROR, "message": "No import running"})


HANDLERS: dict[str, callable] = {
    "ping": lambda _cmd: _emit({"type": PROGRESS_TYPE_PONG}),
    "authenticate": _handle_authenticate,
    "import": _handle_import,
    "validate": _handle_validate,
    "analyze": _handle_analyze,
    "cancel": _handle_cancel,
    "models": _handle_models,
    "fields": _handle_fields,
}


def _stdin_reader(cmd_queue: queue.Queue) -> None:
    """Read stdin in a background thread.

    Cancel commands are handled immediately (thread-safe flag set) so they
    take effect while a long-running import blocks the main thread.
    All other commands are queued for the main thread.
    """
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            _emit({"type": PROGRESS_TYPE_ERROR, "message": f"Invalid JSON: {e}"})
            continue

        if cmd.get("action") == "cancel":
            _handle_cancel(cmd)
        else:
            cmd_queue.put(cmd)

    # stdin closed — signal main thread to exit
    cmd_queue.put(None)


def main() -> None:
    """Read JSON commands from stdin, dispatch to handlers.

    Stdin is read in a separate thread so that cancel commands can be
    processed immediately while a long-running import blocks the main loop.
    """
    cmd_queue: queue.Queue = queue.Queue()
    reader = threading.Thread(target=_stdin_reader, args=(cmd_queue,), daemon=True)
    reader.start()

    while True:
        cmd = cmd_queue.get()
        if cmd is None:
            break

        action = cmd.get("action")
        handler = HANDLERS.get(action)
        if handler:
            handler(cmd)
        else:
            _emit({"type": PROGRESS_TYPE_ERROR, "message": f"Unknown action: {action}"})


if __name__ == "__main__":
    main()
