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
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Callable, Optional

from .backend import OdooBackend, FieldInfo
from .constants import (
    DEFAULT_BATCH_SIZE, MIN_BATCH_SIZE, MAX_BATCH_SIZE,
    MIN_WORKERS, MAX_WORKERS, DEFAULT_WORKERS,
    DEFAULT_IMPORT_MODULE, MODEL_IR_MODEL_DATA,
    FIELD_EXTERNAL_ID, FIELD_OPERATION, FIELD_ID,
    OP_CREATE, OP_UPDATE, OP_SKIP, VALID_OPERATIONS,
    STRATEGY_EXTERNAL_ID, STRATEGY_SEARCH_KEYS, STRATEGY_DB_ID,
    STRATEGY_CREATE, STRATEGY_EXPLICIT_OP,
)
from .transformer import transform_row_data
from .resolver import prefetch_references, resolve_row
from .parser import (
    ParsedRow, ParseOptions, parse_csv_file, parse_csv_batched, count_csv_rows,
)
from .progress import ProgressReporter, NullReporter

_logger = logging.getLogger(__name__)


@dataclass
class ImportConfig:
    """Configuration for an import run."""
    model: str
    field_mappings: dict  # CSV column -> Odoo field
    use_external_id: bool = False
    search_keys: Optional[list[str]] = None
    dry_run: bool = False
    strict: bool = False
    batch_size: int = DEFAULT_BATCH_SIZE


@dataclass
class RowResult:
    """Result of importing a single row."""
    ok: bool
    row_index: int
    error: Optional[str] = None
    record_id: Optional[int] = None
    external_id: Optional[str] = None
    action: Optional[str] = None  # 'created', 'updated', 'skipped'
    strategy: Optional[str] = None
    dry_run: bool = False


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
        results = importer.import_csv_file('/path/to/file.csv', workers=4)
    """

    def __init__(self, backend: OdooBackend, config: ImportConfig,
                 reporter: Optional[ProgressReporter] = None,
                 cancel_check: Optional[Callable[[], bool]] = None):
        """
        Args:
            backend: OdooBackend instance (OrmBackend or RpcBackend)
            config: Import configuration
            reporter: Progress reporter (NullReporter if omitted)
            cancel_check: Optional callable returning True to cancel import
        """
        self.backend = backend
        self.config = config
        self.reporter = reporter or NullReporter()
        self.cancel_check = cancel_check
        self._field_info_cache: Optional[dict[str, FieldInfo]] = None
        self._cancelled = False

    def _get_field_info(self) -> dict[str, FieldInfo]:
        """Get and cache field info for the target model."""
        if self._field_info_cache is None:
            self._field_info_cache = self.backend.get_field_info(self.config.model)
        return self._field_info_cache

    def cancel(self) -> None:
        """Request cancellation. Takes effect before the next batch."""
        self._cancelled = True

    def _is_cancelled(self) -> bool:
        """Check if import should stop."""
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

        # 1. Transform rows using field mappings
        transformed: list[tuple[int, dict]] = []
        for row in rows:
            if self.config.field_mappings:
                mapped = transform_row_data(row.data, self.config.field_mappings)
            else:
                mapped = dict(row.data)
            transformed.append((row.index, mapped))

        # 2. Prefetch all external ID references in batch
        raw_rows = [t[1] for t in transformed]
        try:
            ref_map = prefetch_references(
                self.backend, self.config.model, field_info, raw_rows
            )
        except ValueError as e:
            return [
                RowResult(ok=False, row_index=t[0], error=str(e))
                for t in transformed
            ]

        # 3. Import row by row with savepoints
        results: list[RowResult] = []
        for row_index, row_data in transformed:
            result = self._import_single_row_safe(
                row_index, row_data, field_info, ref_map
            )
            results.append(result)
            self.reporter.row_completed(row_index, result.ok, result.error or '')

        return results

    def import_pre_transformed_rows(self, rows: list[dict]) -> list[RowResult]:
        """
        Import rows already in Odoo field format (legacy API compatibility).
        """
        parsed = [ParsedRow(index=i + 1, data=row) for i, row in enumerate(rows)]
        saved = self.config.field_mappings
        self.config.field_mappings = {}
        try:
            return self.import_rows(parsed)
        finally:
            self.config.field_mappings = saved

    def import_csv_file(
        self,
        file_path: str,
        options: Optional[ParseOptions] = None,
        workers: int = 1,
    ) -> list[RowResult]:
        """
        Import from a local CSV file.

        Args:
            file_path: Path to CSV file
            options: CSV parsing options
            workers: Number of parallel workers (1-4). Multiple workers
                     overlap network latency in RPC mode. Use 1 for ORM mode.

        Returns:
            List of RowResult for all rows
        """
        import os
        opts = options or ParseOptions()
        workers = max(MIN_WORKERS, min(MAX_WORKERS, workers))

        total_rows = count_csv_rows(file_path, opts.encoding, opts.has_header)
        filename = os.path.basename(file_path)
        self.reporter.file_started(filename, total_rows)

        self.backend.check_access_rights(self.config.model, 'create')
        self.backend.check_access_rights(self.config.model, 'write')

        if self.config.search_keys:
            field_info = self._get_field_info()
            for key in self.config.search_keys:
                if key not in field_info:
                    error = f"Search key '{key}' not found on model {self.config.model}"
                    self.reporter.error(error)
                    return []

        all_results: list[RowResult] = []
        processed = 0
        success = 0
        failed = 0

        source = parse_csv_file(file_path, opts)

        if workers <= 1:
            # Sequential mode (OrmBackend or single worker)
            def process_batch(batch: list[ParsedRow]) -> None:
                nonlocal processed, success, failed
                if self._is_cancelled():
                    return
                results = self.import_rows(batch)
                all_results.extend(results)
                batch_ok = sum(1 for r in results if r.ok)
                batch_fail = sum(1 for r in results if not r.ok)
                processed += len(results)
                success += batch_ok
                failed += batch_fail
                self.reporter.batch_completed(processed, total_rows, success, failed)

            parse_csv_batched(source, self.config.batch_size, process_batch)
        else:
            # Parallel mode (RpcBackend — overlaps network latency)
            lock = threading.Lock()
            batches = parse_csv_batched(source, self.config.batch_size)

            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {}
                for batch in batches:
                    if self._is_cancelled():
                        break
                    future = executor.submit(self.import_rows, batch)
                    futures[future] = batch

                for future in as_completed(futures):
                    if self._is_cancelled():
                        break
                    try:
                        results = future.result()
                    except Exception as e:
                        batch = futures[future]
                        results = [
                            RowResult(ok=False, row_index=r.index, error=str(e))
                            for r in batch
                        ]

                    with lock:
                        all_results.extend(results)
                        batch_ok = sum(1 for r in results if r.ok)
                        batch_fail = sum(1 for r in results if not r.ok)
                        processed += len(results)
                        success += batch_ok
                        failed += batch_fail

                    self.reporter.batch_completed(processed, total_rows, success, failed)

        self.reporter.file_completed(filename, success, failed)

        if failed > 0:
            _logger.info(
                "%s: %d/%d rows imported, %d failed",
                filename, success, success + failed, failed,
            )
            # Log first few unique errors as samples
            errors = [r for r in all_results if not r.ok]
            seen_errors: set[str] = set()
            for r in errors:
                msg = r.error or ''
                # Deduplicate by first 80 chars
                key = msg[:80]
                if key not in seen_errors:
                    seen_errors.add(key)
                    _logger.info("  Row %d: %s", r.row_index, msg[:200])
                if len(seen_errors) >= 5:
                    remaining = len(errors) - 5
                    if remaining > 0:
                        _logger.info("  ... and %d more errors", remaining)
                    break
        else:
            _logger.info("%s: %d rows imported successfully", filename, success)

        return all_results

    # -------------------------------------------------------------------------
    # Row-level import logic
    # -------------------------------------------------------------------------

    def _import_single_row_safe(
        self, row_index: int, row_data: dict,
        field_info: dict[str, FieldInfo], ref_map: dict,
    ) -> RowResult:
        """Import a single row with savepoint isolation."""
        try:
            sp = self.backend.savepoint()
            with sp:
                resolved, _warnings = resolve_row(
                    self.backend, self.config.model, field_info, row_data, ref_map
                )
                result = self._import_row(resolved)
                result.row_index = row_index

                if self.config.dry_run:
                    sp.rollback()
                    result.dry_run = True

                return result

        except Exception as e:
            error_msg = str(e)
            # Only log at debug level per-row — summary is logged at end
            _logger.debug("Row %d failed (%s): %s", row_index, self.config.model, error_msg)
            return RowResult(ok=False, row_index=row_index, error=error_msg)

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
                ok=False, row_index=0,
                error=f"Missing search keys: {', '.join(missing_keys)}"
            )

        if record_id:
            self.backend.write(self.config.model, [record_id], row)
            return RowResult(
                ok=True, row_index=0,
                record_id=record_id, external_id=external_id,
                action='updated', strategy=strategy_used,
            )

        # If .id (database ID) was provided but record not found, fail instead
        # of creating — the user intended to update a specific record by ID.
        if db_id:
            return RowResult(
                ok=False, row_index=0,
                error=f"Record with .id={db_id} not found in {self.config.model}",
            )

        # Create new record
        new_id = self.backend.create(self.config.model, row)
        if self.config.use_external_id and external_id:
            self._create_external_id(new_id, external_id)
        return RowResult(
            ok=True, row_index=0,
            record_id=new_id, external_id=external_id,
            action='created', strategy=STRATEGY_CREATE,
        )

    def _resolve_record(
        self, row: dict, external_id: Optional[str], db_id: Optional[int],
    ) -> tuple[Optional[int], Optional[str], list[str]]:
        """
        Find existing record using the standard lookup chain:
        1. External ID  2. Natural Key Search  3. Database ID (legacy)
        """
        # Strategy 1: External ID lookup
        if self.config.use_external_id and external_id:
            record_id = self._find_by_external_id(external_id)
            if record_id:
                return record_id, STRATEGY_EXTERNAL_ID, []

        # Strategy 2: Natural Key Search
        missing_keys: list[str] = []
        if self.config.search_keys:
            missing_keys = [
                k for k in self.config.search_keys
                if k not in row or row[k] == ''
            ]
            if not missing_keys:
                record_id = self._find_by_search_keys(row)
                if record_id:
                    return record_id, STRATEGY_SEARCH_KEYS, []

        # Fallback: Database ID lookup (legacy)
        if db_id:
            if self.backend.browse_exists(self.config.model, int(db_id)):
                return int(db_id), STRATEGY_DB_ID, []

        return None, None, missing_keys

    def _handle_explicit_operation(
        self, row: dict, operation: str,
        external_id: Optional[str], db_id: Optional[int],
    ) -> RowResult:
        """Handle explicit operation column (__op__: create, update, skip)."""
        operation = operation.lower().strip()

        if operation == OP_SKIP:
            return RowResult(
                ok=True, row_index=0,
                action='skipped', strategy=STRATEGY_EXPLICIT_OP,
            )

        elif operation == OP_CREATE:
            new_id = self.backend.create(self.config.model, row)
            if self.config.use_external_id and external_id:
                self._create_external_id(new_id, external_id)
            return RowResult(
                ok=True, row_index=0,
                record_id=new_id, external_id=external_id,
                action='created', strategy=STRATEGY_EXPLICIT_OP,
            )

        elif operation == OP_UPDATE:
            record_id, _, _ = self._resolve_record(row, external_id, db_id)
            if not record_id:
                return RowResult(
                    ok=False, row_index=0,
                    error='Update requested but record not found',
                )
            self.backend.write(self.config.model, [record_id], row)
            return RowResult(
                ok=True, row_index=0,
                record_id=record_id, external_id=external_id,
                action='updated', strategy=STRATEGY_EXPLICIT_OP,
            )

        else:
            valid = ', '.join(sorted(VALID_OPERATIONS))
            return RowResult(
                ok=False, row_index=0,
                error=f"Unknown operation: {operation}. Valid: {valid}",
            )

    def _find_by_search_keys(self, row: dict) -> Optional[int]:
        """Find record by natural key search. All keys must match exactly."""
        domain = [
            (key, '=', row[key])
            for key in self.config.search_keys
            if key in row
        ]
        if len(domain) != len(self.config.search_keys):
            return None

        ids = self.backend.search(self.config.model, domain, limit=2)
        if isinstance(ids, list) and len(ids) > 0:
            if isinstance(ids[0], dict):
                return ids[0]['id']
            if len(ids) > 1:
                _logger.warning(
                    "Natural key search found %d records for %s. Using first.",
                    len(ids), self.config.model
                )
            return ids[0]
        return None

    def _find_by_external_id(self, external_id: str) -> Optional[int]:
        """Find record by external ID (module.name format)."""
        if '.' not in external_id:
            external_id = f'{DEFAULT_IMPORT_MODULE}.{external_id}'

        module, name = external_id.split('.', 1)

        results = self.backend.search_read(
            MODEL_IR_MODEL_DATA,
            [
                ('module', '=', module),
                ('name', '=', name),
                ('model', '=', self.config.model),
            ],
            ['res_id'],
            limit=1,
        )

        if results:
            res_id = results[0]['res_id']
            if self.backend.browse_exists(self.config.model, res_id):
                return res_id
        return None

    def _create_external_id(self, record_id: int, external_id: str) -> None:
        """Create ir.model.data entry for external ID."""
        if '.' in external_id:
            module, name = external_id.split('.', 1)
        else:
            module, name = DEFAULT_IMPORT_MODULE, external_id

        self.backend.create(MODEL_IR_MODEL_DATA, {
            'module': module,
            'name': name,
            'model': self.config.model,
            'res_id': record_id,
        })
