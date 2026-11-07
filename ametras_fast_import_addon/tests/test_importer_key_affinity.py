"""
Parallel imports keep all rows of one record on one worker, in file order.

A file often holds several rows for the same record (several price rows per
article, a corrected row further down). When parallel workers take whole
batches regardless of the record, two workers write the same record at the
same time: PostgreSQL serialization failures and unique violations on the
server, and a final value that is not the one of the last row in the file.

These tests run the parallel path against an in-memory backend that sleeps
inside every write, so overlapping writes on one record are detected
deterministically.

Run with:
    python3 ametras_fast_import_addon/tests/test_importer_key_affinity.py
"""
import csv
import os
import sys
import tempfile
import threading
import time
import unittest

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.backend import FieldInfo, OdooBackend  # noqa: E402
from import_engine.importer import ImportConfig, Importer  # noqa: E402
from import_engine.parser import ParseOptions  # noqa: E402

WRITE_DELAY_SECONDS = 0.01


class InMemoryBackend(OdooBackend):
    """Records keyed by a natural key; flags concurrent writes on one record."""

    def __init__(self, keys):
        self._lock = threading.Lock()
        self.records = {i + 1: {"code": k, "price": None} for i, k in enumerate(keys)}
        self.xmlids = {}
        self.active = set()
        self.overlaps = []
        self.next_id = len(self.records) + 1
        self._fields = {
            "code": FieldInfo("code", "char"),
            "price": FieldInfo("price", "char"),
            "name": FieldInfo("name", "char"),
            "parent_id": FieldInfo("parent_id", "many2one", "res.partner"),
        }

    def _enter(self, record_id):
        with self._lock:
            if record_id in self.active:
                self.overlaps.append(record_id)
            self.active.add(record_id)

    def _leave(self, record_id):
        with self._lock:
            self.active.discard(record_id)

    def search(self, model, domain, fields=None, limit=None):
        wanted = {field: value for field, _op, value in domain}
        with self._lock:
            return [
                rid
                for rid, rec in self.records.items()
                if all(rec.get(f) == v for f, v in wanted.items())
            ][: limit or None]

    def create(self, model, vals):  # pylint: disable=method-required-super
        if model == "ir.model.data":
            with self._lock:
                self.xmlids[(vals["module"], vals["name"])] = vals["res_id"]
            return len(self.xmlids)
        time.sleep(WRITE_DELAY_SECONDS)
        with self._lock:
            rid = self.next_id
            self.next_id += 1
            self.records[rid] = dict(vals)
        return rid

    def write(self, model, ids, vals):  # pylint: disable=method-required-super
        for rid in ids:
            self._enter(rid)
        try:
            time.sleep(WRITE_DELAY_SECONDS)
            with self._lock:
                for rid in ids:
                    self.records[rid].update(vals)
        finally:
            for rid in ids:
                self._leave(rid)
        return True

    def search_read(self, model, domain, fields, limit=None):
        if model != "ir.model.data":
            return []

        def matches(value, wanted):
            return (
                value in wanted
                if isinstance(wanted, (list, tuple))
                else value == wanted
            )

        terms = {field: value for field, _op, value in domain}
        with self._lock:
            return [
                {"module": module, "name": name, "res_id": rid}
                for (module, name), rid in self.xmlids.items()
                if matches(module, terms.get("module", module))
                and matches(name, terms.get("name", name))
            ]

    def browse_exists(self, model, record_id):
        with self._lock:
            return record_id in self.records

    def name_search(self, model, value):
        with self._lock:
            return [
                (rid, rec["name"])
                for rid, rec in sorted(self.records.items())
                if rec.get("name") == value
            ][:2]

    def execute(self, model, method, *args, **kwargs):
        return []

    def get_field_info(self, model):
        return self._fields


def write_csv(header, rows):
    fd, path = tempfile.mkstemp(suffix=".csv")
    with os.fdopen(fd, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        writer.writerows(rows)
    return path


def repeated_key_rows(keys, repeats):
    """Each key `repeats` times, the repeats in consecutive blocks so they fall
    into neighbouring batches that run at the same time."""
    rows = []
    for rep in range(repeats):
        for key in keys:
            rows.append([key, f"{key}-v{rep}"])
    return rows


class TestKeyAffinityBySearchKey(unittest.TestCase):
    """Updates found through search keys (e.g. a price list by article number)."""

    def setUp(self):
        super().setUp()
        self.keys = [f"A{i:03d}" for i in range(6)]
        self.rows = repeated_key_rows(self.keys, repeats=6)
        self.path = write_csv(["code", "price"], self.rows)
        self.addCleanup(os.remove, self.path)

    def _run(self, workers):
        backend = InMemoryBackend(self.keys)
        config = ImportConfig(
            model="product.template",
            field_mappings={"code": "code", "price": "price"},
            search_keys=["code"],
            batch_size=3,
        )
        summary = Importer(backend, config).import_csv_file(
            self.path, ParseOptions(), workers=workers
        )
        return backend, summary

    def test_parallel_import_never_writes_one_record_concurrently(self):
        backend, summary = self._run(workers=4)
        self.assertEqual(
            summary.failed, 0, msg=f"No row should fail, errors: {summary.errors}"
        )
        self.assertEqual(
            backend.overlaps,
            [],
            msg="Two workers wrote the same record at the same time "
            f"(record ids {sorted(set(backend.overlaps))})",
        )

    def test_parallel_import_keeps_last_row_value(self):
        backend, _summary = self._run(workers=4)
        last = {key: value for key, value in self.rows}
        final = {rec["code"]: rec["price"] for rec in backend.records.values()}
        wrong = {k: (final.get(k), v) for k, v in last.items() if final.get(k) != v}
        self.assertEqual(
            wrong,
            {},
            msg="Final value must be the one of the last row in the file "
            "(key: (found, expected))",
        )

    def test_sequential_import_is_unchanged(self):
        backend, summary = self._run(workers=1)
        self.assertEqual(summary.success, len(self.rows))
        self.assertEqual(backend.overlaps, [])


class TestKeyAffinityByExternalId(unittest.TestCase):
    """Creates with external IDs: a repeated ID must update, never create twice."""

    def test_repeated_external_id_creates_one_record(self):
        xmlids = [f"rec_{i}" for i in range(6)]
        rows = []
        for rep in range(4):
            for xid in xmlids:
                # The same ID written with and without the default module
                # prefix is the same record.
                ref = xid if rep % 2 == 0 else f"__import__.{xid}"
                rows.append([ref, f"{xid}-v{rep}"])
        path = write_csv(["id", "price"], rows)
        self.addCleanup(os.remove, path)
        backend = InMemoryBackend([])
        config = ImportConfig(
            model="product.template",
            field_mappings={"id": "id", "price": "price"},
            use_external_id=True,
            batch_size=3,
        )
        summary = Importer(backend, config).import_csv_file(
            path, ParseOptions(), workers=4
        )
        self.assertEqual(
            summary.failed, 0, msg=f"No row should fail, errors: {summary.errors}"
        )
        self.assertEqual(
            len(backend.records),
            len(xmlids),
            msg="Each external ID must create exactly one record",
        )
        self.assertEqual(backend.overlaps, [])
        final = {
            name: backend.records[rid]["price"]
            for (_module, name), rid in backend.xmlids.items()
        }
        self.assertEqual(final, {xid: f"{xid}-v3" for xid in xmlids})


class TestNeighbouringRowsStayTogether(unittest.TestCase):
    """A contact naming the company two rows above must find it, as in one
    row-by-row batch: neighbouring rows of new records share a lane."""

    def test_contact_finds_company_created_just_above(self):
        rows = []
        for i in range(12):
            rows.append([f"Company {i}", ""])
            rows.append([f"Contact {i}", f"Company {i}"])
        path = write_csv(["name", "parent_id"], rows)
        self.addCleanup(os.remove, path)
        backend = InMemoryBackend([])
        config = ImportConfig(
            model="res.partner",
            field_mappings={"name": "name", "parent_id": "parent_id"},
            batch_size=4,
        )
        summary = Importer(backend, config).import_csv_file(
            path, ParseOptions(), workers=4
        )
        self.assertEqual(
            summary.failed, 0, msg=f"No contact may miss its company: {summary.errors}"
        )
        by_name = {rec["name"]: rid for rid, rec in backend.records.items()}
        for i in range(12):
            contact = backend.records[by_name[f"Contact {i}"]]
            self.assertEqual(contact["parent_id"], by_name[f"Company {i}"])


class TestRowsWithoutKey(unittest.TestCase):
    """Plain creates have no record key and are still spread over all workers."""

    def test_keyless_rows_all_imported(self):
        rows = [[f"N{i}", str(i)] for i in range(30)]
        path = write_csv(["code", "price"], rows)
        self.addCleanup(os.remove, path)
        backend = InMemoryBackend([])
        config = ImportConfig(
            model="product.supplierinfo",
            field_mappings={"code": "code", "price": "price"},
            batch_size=4,
        )
        summary = Importer(backend, config).import_csv_file(
            path, ParseOptions(), workers=4
        )
        self.assertEqual(summary.success, 30)
        self.assertEqual(len(backend.records), 30)


if __name__ == "__main__":
    unittest.main()
