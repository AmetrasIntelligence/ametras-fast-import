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
import zlib
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace as dc_replace
from typing import Callable, Iterator

from .backend import FieldInfo, OdooBackend, TransportError
from .constants import (
    CREATE_LOST_MESSAGE,
    DEFAULT_BATCH_SIZE,
    DEFAULT_IMPORT_MODULE,
    FIELD_EXTERNAL_ID,
    FIELD_ID,
    FIELD_OPERATION,
    LANE_TABLE_SIZE,
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
    SERIALIZATION_RETRY_BASE_DELAY,
    SERIALIZATION_RETRY_MAX_ATTEMPTS,
    SERIALIZATION_RETRY_MAX_DELAY,
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
    XMLID_LOST_MESSAGE,
)
from .load_batch import (
    BATCH_UPDATE_MODELS,
    BULK_SEARCH_KEY_TYPES,
    LOAD_CONTEXT,
    ROW_BY_ROW,
    NotBatchable,
    is_concurrency_message,
    load_cell,
    load_errors,
)
from .parser import (
    ParsedRow,
    ParseOptions,
    count_csv_rows,
    parse_csv_batched,
    parse_csv_file,
)
from .progress import NullReporter, ProgressReporter
from .resolver import _NAME_CACHE, prefetch_references, resolve_row
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
    # Write each batch with few calls (one create() for new records, load()
    # for updates of some models, see _import_batched) instead of one
    # create/write per row. Off by default: switched on per profile.
    batch_write: bool = False


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
        # batched creates that lost their connection (see _create_group)
        self._create_timeouts = 0
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

        # 3. Import: batched through load() where the backend and the run allow
        #    it, otherwise row by row with savepoints
        if self._batch_write_enabled():
            results = self._import_batched(transformed, field_info, ref_map)
            for result in results:
                self.reporter.row_completed(
                    result.row_index, result.ok, result.error or ""
                )
            return transform_errors + results

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

    # -------------------------------------------------------------------------
    # Batched writes
    # -------------------------------------------------------------------------

    def _batch_write_enabled(self) -> bool:
        """Batched writes need a backend that can write batches and a plain run.

        Dry runs and strict mode keep the row-by-row write: both depend on
        per-row savepoints and per-row lookups.
        """
        return (
            self.config.batch_write
            and getattr(self.backend, "supports_load", False)
            and not self.config.dry_run
            and not self.config.strict
        )

    def _import_batched(
        self,
        transformed: list[tuple[int, dict]],
        field_info: dict[str, FieldInfo],
        ref_map: dict,
    ) -> list[RowResult]:
        """Import transformed rows with as few calls as possible.

        The rows are resolved exactly as for a row-by-row import and collected,
        in file order, into steps of rows that write distinct records. A step
        is written before the next row joins when

        - the next row carries an identifier (external ID, search key values,
          database ID) a collected row carries, so the lookup before each step
          sees every record an earlier row created or changed;
        - the next row has an explicit operation: it is written row by row;
        - the next row cannot be resolved yet (see _resolve_for_batch).
        """
        results: dict[int, RowResult] = {}
        current: list[tuple[int, dict, dict]] = []
        claimed: set[str] = set()

        def write_current():
            nonlocal current, claimed
            if current:
                for result in self._write_step(current, field_info, ref_map):
                    results[result.row_index] = result
            current, claimed = [], set()

        for row_index, row_data in transformed:
            if current and self._names_record_of_import_model(row_data, field_info):
                # Row by row, a reference by name sees the records the rows
                # above created (a second company of the same name makes it
                # ambiguous): write those rows before resolving this one.
                write_current()
            try:
                resolved = self._resolve_for_batch(
                    row_data, field_info, ref_map, bool(current), write_current
                )
            except TransportError:
                raise
            except Exception as e:  # same per-row failure as the row path
                results[row_index] = RowResult(
                    ok=False, row_index=row_index, error=str(e)
                )
                continue
            if FIELD_OPERATION in resolved:
                write_current()
                results[row_index] = self._import_single_row_safe(
                    row_index, row_data, field_info, ref_map
                )
                continue
            # Identities of the resolved row: a reference written by name in one
            # row and by external ID in another is the same id here.
            identities = self._mapped_row_identities(resolved)
            if identities & claimed:
                write_current()
            current.append((row_index, row_data, resolved))
            claimed |= identities
            if self._search_keys_read_by_server(resolved):
                # The server reads such a key ("1", "1.0", "2026-3-1") in ways
                # the identities cannot compare: the row is its own step, so
                # the lookup of the next row sees what it created.
                write_current()
        write_current()

        return [results[idx] for idx, _data in transformed if idx in results]

    def _names_record_of_import_model(
        self, row_data: dict, field_info: dict[str, FieldInfo]
    ) -> bool:
        """True when the row references a record of the imported model by
        text (name or external ID), which earlier rows may have created."""
        for name, value in row_data.items():
            info = field_info.get(name)
            if (
                info is not None
                and info.type in ("many2one", "many2many")
                and info.comodel_name == self.config.model
                and isinstance(value, str)
                and value.strip()
            ):
                return True
        return False

    def _search_keys_read_by_server(self, resolved: dict) -> bool:
        """True when the row has complete search keys of a type the bulk lookup
        leaves to the server's "=" (numbers, dates, ...)."""
        keys = self.config.search_keys or []
        if not keys or not all(resolved.get(k) not in (None, "") for k in keys):
            return False
        field_info = self._get_field_info()
        return not all(
            getattr(field_info.get(k), "type", None) in BULK_SEARCH_KEY_TYPES
            for k in keys
        )

    def _resolve_for_batch(
        self,
        row_data: dict,
        field_info: dict[str, FieldInfo],
        ref_map: dict,
        has_pending: bool,
        write_pending: Callable[[], None],
    ) -> dict:
        """resolve_row, with the rows collected so far written first on a miss.

        Row by row, every row is resolved after the rows before it are
        written, so a reference by name to a record an earlier row creates
        (a contact naming its company) is found. When resolving fails while
        rows are still waiting to be written, those rows are written and the
        row is resolved once more, which gives the same outcome.
        """
        name_cache = ref_map.setdefault(_NAME_CACHE, {})
        known = len(name_cache)
        try:
            return resolve_row(
                self.backend, self.config.model, field_info, row_data, ref_map
            )[0]
        except TransportError:
            raise
        except Exception:
            if not has_pending:
                raise
        write_pending()
        # Forget the misses this attempt cached (dicts keep insertion order, so
        # they are the entries after `known`); misses of earlier rows stay,
        # exactly as row by row.
        for key in list(name_cache)[known:]:
            if name_cache[key] is None:
                del name_cache[key]
        return resolve_row(
            self.backend, self.config.model, field_info, row_data, ref_map
        )[0]

    def _write_step(
        self,
        rows: list[tuple[int, dict, dict]],
        field_info: dict[str, FieldInfo],
        ref_map: dict,
    ) -> list[RowResult]:
        """Look up the records of one step and write it.

        New records are created with one create() call for the whole step, in
        file order. Updates go through load() for the models in
        BATCH_UPDATE_MODELS (grouped by their columns); on other models, and
        for values without a load() form, each update is written row by row.
        When the bulk lookup itself fails, the step is written row by row, so
        every row gets the outcome it gets today.
        """
        try:
            found = self._lookup_records([resolved for _i, _d, resolved in rows])
        except TransportError:
            raise
        except Exception:
            return self._rows_one_by_one(rows, field_info, ref_map)

        # Two rows of this step may still reach the same record through
        # different identifiers (a database ID and search key values). Write
        # the rows before the second one first, then look the rest up again.
        seen: set[int] = set()
        for pos, (record_id, _strategy) in enumerate(found):
            if record_id and record_id is not ROW_BY_ROW:
                if record_id in seen:
                    return self._write_found(
                        rows[:pos], found[:pos], field_info, ref_map
                    ) + self._write_step(rows[pos:], field_info, ref_map)
                seen.add(record_id)
        return self._write_found(rows, found, field_info, ref_map)

    def _rows_one_by_one(self, rows, field_info, ref_map) -> list[RowResult]:
        return [
            self._import_single_row_safe(row_index, row_data, field_info, ref_map)
            for row_index, row_data, _resolved in rows
        ]

    def _write_found(
        self,
        rows: list[tuple[int, dict, dict]],
        found: list[tuple],
        field_info: dict[str, FieldInfo],
        ref_map: dict,
    ) -> list[RowResult]:
        model = self.config.model
        results: list[RowResult] = []
        creates: list[tuple[int, dict, dict, str | None, RowResult]] = []
        updates: dict[tuple, list[tuple[int, dict, list[str], RowResult]]] = {}
        update_by_load = model in BATCH_UPDATE_MODELS

        for (row_index, row_data, resolved), (record_id, strategy) in zip(
            rows, found, strict=True
        ):
            if record_id is ROW_BY_ROW:
                results.append(
                    self._import_single_row_safe(
                        row_index, row_data, field_info, ref_map
                    )
                )
                continue
            row = dict(resolved)
            external_id = row.pop(FIELD_EXTERNAL_ID, None)
            db_id = row.pop(FIELD_ID, None)
            if not record_id and db_id:
                results.append(
                    RowResult(
                        ok=False,
                        row_index=row_index,
                        error="Record with .id=%s not found in %s" % (db_id, model),
                    )
                )
                continue
            if not record_id:
                xmlid = None
                if self.config.use_external_id and external_id:
                    xmlid = (
                        external_id
                        if "." in external_id
                        else f"{DEFAULT_IMPORT_MODULE}.{external_id}"
                    )
                outcome = RowResult(
                    ok=True,
                    row_index=row_index,
                    external_id=external_id,
                    action="created",
                    strategy=STRATEGY_CREATE,
                )
                creates.append(
                    (
                        row_index,
                        row_data,
                        self._filter_writable(row, is_update=False),
                        xmlid,
                        outcome,
                    )
                )
                continue
            vals = self._filter_writable(row, is_update=True)
            outcome = RowResult(
                ok=True,
                row_index=row_index,
                record_id=record_id,
                external_id=external_id,
                action="updated",
                strategy=strategy,
            )
            try:
                if not update_by_load:
                    raise NotBatchable(f"updates of {model} are written row by row")
                columns, cells = [".id"], [str(record_id)]
                for name in sorted(vals):
                    column, cell = load_cell(field_info.get(name), name, vals[name])
                    columns.append(column)
                    cells.append(cell)
            except NotBatchable:
                results.append(
                    self._import_single_row_safe(
                        row_index, row_data, field_info, ref_map
                    )
                )
                continue
            updates.setdefault(tuple(columns), []).append(
                (row_index, row_data, cells, outcome)
            )

        if creates:
            results.extend(self._create_group(creates, field_info, ref_map))
        for columns, group in updates.items():
            results.extend(self._load_group(list(columns), group, field_info, ref_map))
        return results

    def _lookup_records(self, resolved_rows: list[dict]) -> list[tuple]:
        """Find the existing record of each row with a few bulk reads.

        Same identifiers and the same order as _resolve_record: external ID,
        then complete search keys, then database ID. A row whose lookup the
        bulk reads cannot answer exactly as _resolve_record does gets
        ROW_BY_ROW and is written row by row.
        """
        model = self.config.model
        found: list[tuple] = [(None, None)] * len(resolved_rows)

        # external IDs
        if self.config.use_external_id:
            wanted: dict[tuple[str, str], list[int]] = {}
            for pos, row in enumerate(resolved_rows):
                external_id = row.get(FIELD_EXTERNAL_ID)
                if not external_id:
                    continue
                if "." not in external_id:
                    external_id = f"{DEFAULT_IMPORT_MODULE}.{external_id}"
                module, name = external_id.split(".", 1)
                wanted.setdefault((module, name), []).append(pos)
            if wanted:
                hits = self.backend.search_read(
                    MODEL_IR_MODEL_DATA,
                    [
                        ("module", "in", sorted({m for m, _n in wanted})),
                        ("name", "in", sorted({n for _m, n in wanted})),
                        ("model", "=", model),
                    ],
                    ["module", "name", "res_id"],
                )
                by_key = {(h["module"], h["name"]): h["res_id"] for h in hits}
                alive = self.backend.existing_ids(model, list(by_key.values()))
                for key, positions in wanted.items():
                    if key not in by_key:
                        continue
                    res_id = by_key[key]
                    # An external ID whose record the lookup does not see (an
                    # archived record over RPC) goes row by row, where it
                    # keeps today's outcome.
                    hit = (
                        (res_id, STRATEGY_EXTERNAL_ID)
                        if res_id in alive
                        else (ROW_BY_ROW, None)
                    )
                    for pos in positions:
                        found[pos] = hit

        # search keys
        keys = self.config.search_keys or []
        if keys:
            pending = [
                pos
                for pos, row in enumerate(resolved_rows)
                if found[pos][0] is None
                and all(k in row and row[k] != "" for k in keys)
            ]
            if pending:
                for pos, record_id in self._find_many_by_search_keys(
                    [resolved_rows[p] for p in pending]
                ).items():
                    found[pending[pos]] = (record_id, STRATEGY_SEARCH_KEYS)

        # database IDs
        pending = [
            pos
            for pos, row in enumerate(resolved_rows)
            if found[pos][0] is None and row.get(FIELD_ID)
        ]
        if pending:
            alive = self.backend.existing_ids(
                model, [int(resolved_rows[p][FIELD_ID]) for p in pending]
            )
            for pos in pending:
                db_id = int(resolved_rows[pos][FIELD_ID])
                if db_id in alive:
                    found[pos] = (db_id, STRATEGY_DB_ID)
        return found

    def _find_many_by_search_keys(self, rows: list[dict]) -> dict[int, int]:
        """Position -> first matching record id, as _find_by_search_keys finds it.

        Search keys on text, selection and many2one fields are matched with one
        read; the values compare exactly as the server's "=" does. Keys of
        other types (numbers, dates, ...) are searched row by row with "=", so
        the server converts the value exactly as before.
        """
        keys = self.config.search_keys or []
        field_info = self._get_field_info()
        types = {k: getattr(field_info.get(k), "type", None) for k in keys}
        if not all(t in BULK_SEARCH_KEY_TYPES for t in types.values()):
            out = {}
            for pos, row in enumerate(rows):
                record_id = self._find_by_search_keys(row)
                if record_id:
                    out[pos] = record_id
            return out

        def norm(key, value):
            if types[key] == "many2one":
                if isinstance(value, (list, tuple)):
                    value = value[0] if value else False
                return value
            return value if value is False else str(value)

        if len(keys) == 1:
            key = keys[0]
            domain = [(key, "in", sorted({row[key] for row in rows}, key=str))]
        else:
            terms = [[(k, "=", row[k]) for k in keys] for row in rows]
            domain = ["|"] * (len(terms) - 1)
            for term in terms:
                domain += ["&"] * (len(term) - 1) + term
        hits = self.backend.search_read(self.config.model, domain, ["id"] + keys)
        first: dict[tuple, int] = {}
        for hit in hits:
            values = tuple(norm(k, hit[k]) for k in keys)
            first.setdefault(values, hit["id"])
        out = {}
        for pos, row in enumerate(rows):
            values = tuple(norm(k, row[k]) for k in keys)
            if values in first:
                out[pos] = first[values]
        return out

    def _create_group(
        self,
        group: list[tuple[int, dict, dict, str | None, RowResult]],
        field_info: dict[str, FieldInfo],
        ref_map: dict,
    ) -> list[RowResult]:
        """create() the new records of a step in one call, in file order, then
        their external IDs in one call; on an error halve the group until the
        failing rows are found and write those row by row."""
        model = self.config.model
        # In addon mode (one transaction) the records and their external IDs
        # are created in one savepoint, as one row-by-row savepoint holds a
        # record and its external ID; a failure rolls both back. Over RPC every
        # call commits, so the external IDs follow in their own call.
        transactional = getattr(self.backend, "transactional", False)

        def xmlid_vals(xmlid_rows):
            return [
                {
                    "module": x.split(".", 1)[0],
                    "name": x.split(".", 1)[1],
                    "model": model,
                    "res_id": rid,
                }
                for x, rid, _o in xmlid_rows
            ]

        try:
            with self.backend.savepoint():
                ids = self.backend.create_many(
                    model, [vals for _i, _d, vals, _x, _o in group]
                )
                xmlid_rows = [
                    (xmlid, record_id, outcome)
                    for (_i, _d, _v, xmlid, outcome), record_id in zip(
                        group, ids, strict=True
                    )
                    if xmlid
                ]
                if transactional and xmlid_rows:
                    self.backend.create_many(
                        MODEL_IR_MODEL_DATA, xmlid_vals(xmlid_rows)
                    )
                self.backend.flush_all()
        except TransportError:
            # The server may have created the records before the connection
            # was lost; sending the batch again could create them twice. The
            # rows fail with a message to check them, and the sequential loop
            # shrinks the next batches (see _import_sequential_with_retry).
            self._create_timeouts += 1
            return [
                RowResult(ok=False, row_index=row_index, error=CREATE_LOST_MESSAGE)
                for row_index, _d, _v, _x, _o in group
            ]
        except Exception:
            self.backend.after_rollback()
            if len(group) == 1:
                row_index, row_data, _vals, _xmlid, _outcome = group[0]
                return [
                    self._import_single_row_safe(
                        row_index, row_data, field_info, ref_map
                    )
                ]
            middle = len(group) // 2
            return self._create_group(
                group[:middle], field_info, ref_map
            ) + self._create_group(group[middle:], field_info, ref_map)

        results = []
        for (_i, _d, _vals, _xmlid, outcome), record_id in zip(group, ids, strict=True):
            outcome.record_id = record_id
            results.append(outcome)
        if xmlid_rows and not transactional:
            try:
                self.backend.create_many(MODEL_IR_MODEL_DATA, xmlid_vals(xmlid_rows))
            except TransportError:
                for _xmlid, _record_id, outcome in xmlid_rows:
                    outcome.ok = False
                    outcome.error = XMLID_LOST_MESSAGE
            except Exception:
                # one by one, like the row-by-row write over RPC: a failing
                # external ID fails its row, the record stays created
                for xmlid, record_id, outcome in xmlid_rows:
                    try:
                        self._create_external_id(record_id, xmlid)
                    except TransportError:
                        raise
                    except Exception as e:
                        outcome.ok = False
                        outcome.error = str(e)
        return results

    def _load_group(
        self,
        columns: list[str],
        group: list[tuple[int, dict, list[str], RowResult]],
        field_info: dict[str, FieldInfo],
        ref_map: dict,
        retry_conflicts: bool = True,
    ) -> list[RowResult]:
        """load() one group of updates; on an error halve it until the failing
        rows are found, and write those row by row so they fail with today's
        message. Conflicts are retried for the whole group only; its halves
        go on without new retries (the row-by-row write retries again)."""
        retries = (
            SERIALIZATION_RETRY_MAX_ATTEMPTS
            if retry_conflicts
            and getattr(self.backend, "load_conflicts_retryable", False)
            else 0
        )
        for attempt in range(retries + 1):
            try:
                result = self.backend.load(
                    self.config.model,
                    columns,
                    [cells for _i, _d, cells, _o in group],
                    LOAD_CONTEXT,
                )
            except TransportError:
                raise
            except Exception:  # Fault (already retried by the backend)
                break
            errors = load_errors(result)
            if not errors:
                return self._load_outcomes(group, result)
            self.backend.after_rollback()
            if not any(is_concurrency_message(m) for m in errors):
                break
            if attempt < retries:
                self._backoff(attempt)
        if len(group) == 1:
            row_index, row_data, _cells, _outcome = group[0]
            return [
                self._import_single_row_safe(row_index, row_data, field_info, ref_map)
            ]
        middle = len(group) // 2
        return self._load_group(
            columns, group[:middle], field_info, ref_map, retry_conflicts=False
        ) + self._load_group(
            columns, group[middle:], field_info, ref_map, retry_conflicts=False
        )

    @staticmethod
    def _load_outcomes(group, result) -> list[RowResult]:
        """Row results of a load() call that reported no error.

        load() skips a row it only warns about (no id, nothing rolled back).
        Such rows are matched through the row numbers of the warnings and fail
        with the warning; when the ids cannot be matched to the rows, every
        row fails and nothing is sent again (the other rows are written).
        """
        ids = result.get("ids") or []
        skipped: dict[int, str] = {}
        for message in result.get("messages", []):
            rows = message.get("rows") or {}
            if message.get("type") == "warning" and "from" in rows:
                for i in range(rows["from"], rows.get("to", rows["from"]) + 1):
                    skipped[i] = str(message.get("message", ""))
        if len(ids) != len(group) - len(skipped):
            error = (
                "The batch was written, but its result could not be matched to "
                "the rows. Check these rows in Odoo."
            )
            return [
                RowResult(ok=False, row_index=row_index, error=error)
                for row_index, _d, _c, _o in group
            ]
        out = []
        id_iter = iter(ids)
        for i, (row_index, _d, _c, outcome) in enumerate(group):
            if i in skipped:
                out.append(RowResult(ok=False, row_index=row_index, error=skipped[i]))
            else:
                outcome.record_id = next(id_iter)
                out.append(outcome)
        return out

    def _backoff(self, attempt: int) -> None:
        delay = min(
            SERIALIZATION_RETRY_BASE_DELAY * (2**attempt),
            SERIALIZATION_RETRY_MAX_DELAY,
        )
        end = _time.monotonic() + delay
        while _time.monotonic() < end and not self._is_cancelled():
            _time.sleep(min(0.25, delay))

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
            # Parallel (RpcBackend): every worker is a lane with one thread. A
            # row goes to the lane of the first row that carried one of its
            # identifiers (external ID, search key values, database ID), so rows
            # naming a record the same way run one after the other in file
            # order and the last of them wins. Rows that name one record only
            # through different identifiers (one by external ID, another only
            # by search key) cannot be matched before the lookup and may run on
            # two lanes. Rows of records not seen before fill one lane's batch
            # after the other.
            #
            # Done callbacks process each batch's results immediately so only
            # error RowResults accumulate in all_errors. sem.release() is called
            # inside the callback (after results are consumed) so the semaphore
            # bounds both raw data and result objects in memory.
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

            lanes = [ThreadPoolExecutor(max_workers=1) for _ in range(workers)]
            buffers: list[list[ParsedRow]] = [[] for _ in range(workers)]

            def _submit(lane: int) -> None:
                batch = buffers[lane]
                buffers[lane] = []
                sem.acquire()  # blocks until a callback has freed a slot
                future = lanes[lane].submit(self.import_rows, batch)
                future.add_done_callback(_make_callback([r.index for r in batch]))

            # Lane of every identity seen so far, in a fixed-size table indexed
            # by a hash of the identity (lane + 1, 0 = not seen). A collision
            # only sends a row to the lane of another record, which is safe.
            lane_table = bytearray(LANE_TABLE_SIZE)
            try:
                chunk_lane, chunk_rows = 0, 0
                for row in source:
                    if self._is_cancelled():
                        break
                    slots = [
                        zlib.crc32(identity.encode("utf-8")) % LANE_TABLE_SIZE
                        for identity in sorted(self._row_identities(row))
                    ]
                    known = [lane_table[slot] for slot in slots if lane_table[slot]]
                    if known:
                        lane = known[0] - 1
                    else:
                        # Rows of a record not seen before stay with their
                        # neighbours: consecutive rows fill one lane's batch,
                        # so a row that names a record created a few rows
                        # above runs after it, as in one row-by-row batch.
                        lane = chunk_lane
                        chunk_rows += 1
                        if chunk_rows >= self.config.batch_size:
                            chunk_lane = (chunk_lane + 1) % workers
                            chunk_rows = 0
                    for slot in slots:
                        if not lane_table[slot]:
                            lane_table[slot] = lane + 1
                    buffers[lane].append(row)
                    if len(buffers[lane]) >= self.config.batch_size:
                        _submit(lane)
                if not self._is_cancelled():
                    for lane in range(workers):
                        if buffers[lane]:
                            _submit(lane)
            finally:
                # shutdown(wait=True): all pending batches and their callbacks
                # complete before the summary is built
                for executor in lanes:
                    executor.shutdown(wait=True)

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

    def _row_identities(self, row: ParsedRow) -> set[str]:
        """Every identifier through which a row can reach an existing record.

        The record lookup (_resolve_record) tries the external ID (when
        external IDs are used), then the search key values, then the database
        ID, so a row can reach its record through any of them. An external ID
        without a module is the same as one with the default import module.
        Rows that only create (no identifier) return an empty set.
        """
        try:
            if self.config.field_mappings:
                data = transform_row_data(row.data, self.config.field_mappings)
            else:
                data = dict(row.data)
        except Exception:  # the row fails later in import_rows with its message
            return set()
        return self._mapped_row_identities(data)

    def _mapped_row_identities(self, data: dict) -> set[str]:
        """_row_identities for a row already mapped to Odoo field names."""
        identities = set()
        external_id = data.get(FIELD_EXTERNAL_ID)
        if self.config.use_external_id and external_id:
            external_id = str(external_id)
            if "." not in external_id:
                external_id = f"{DEFAULT_IMPORT_MODULE}.{external_id}"
            identities.add(f"xmlid:{external_id}")
        if self.config.search_keys and all(
            data.get(key) not in (None, "") for key in self.config.search_keys
        ):
            values = tuple(str(data[key]) for key in self.config.search_keys)
            identities.add(f"keys:{values!r}")
        db_id = data.get(FIELD_ID)
        if db_id not in (None, ""):
            identities.add(f"id:{db_id}")
        return identities

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
                    timeouts_before = self._create_timeouts
                    results = self.import_rows(batch)
                    if self._create_timeouts > timeouts_before:
                        # a batched create timed out: its rows failed (never
                        # sent again), the next batches get smaller
                        adapter.record_timeout(
                            success_threshold_after_timeout=(
                                STANDALONE_POST_TIMEOUT_SUCCESS_THRESHOLD
                            )
                        )
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
        - readonly + stored: allowed on update; on create only when one of its
          states makes it writable, the rule Odoo's own import applies (e.g. a
          transfer's operation type and locations, writable in draft).
        """
        field_info = self._get_field_info()
        result = {}
        for key, val in row.items():
            info = field_info.get(key)
            if info is not None and info.readonly:
                if not info.store:
                    continue  # computed non-stored: can never be written
                if not is_update and not info.writable_in_state:
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
