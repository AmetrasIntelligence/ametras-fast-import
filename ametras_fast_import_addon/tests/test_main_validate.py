"""
Tests for the standalone engine's `validate` command (import_engine.__main__).

Drives _handle_validate directly with _emit and _get_backend monkeypatched, so
it needs no subprocess or real Odoo — covers the report event, dropped-field
detection, skip_indices exclusion, batching, and the error path. Pure Python;
runs in CI's test-python job.

Run with: python3 ametras_fast_import_addon/tests/test_main_validate.py
"""
import os
import sys
import unittest

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

import import_engine.__main__ as mainmod  # noqa: E402
from import_engine.backend import FieldInfo, OdooBackend  # noqa: E402


class _Backend(OdooBackend):
    def __init__(self):
        self.records = {}
        self.next_id = {}
        self.field_info_map = {}

    def _ensure(self, model):
        self.records.setdefault(model, {})
        self.next_id.setdefault(model, 1)

    def create(self, model, vals):
        self._ensure(model)
        rid = self.next_id[model]
        self.next_id[model] += 1
        self.records[model][rid] = dict(vals)
        return rid

    def write(self, model, ids, vals):
        self._ensure(model)
        for rid in ids:
            self.records[model].get(rid, {}).update(vals)
        return True

    def execute(self, *a, **k):
        return None

    def get_field_info(self, model):
        return self.field_info_map.get(model, {})

    def browse_exists(self, model, rid):
        self._ensure(model)
        return rid in self.records[model]

    def name_search(self, model, value):
        self._ensure(model)
        return [
            (rid, v.get("name"))
            for rid, v in self.records[model].items()
            if v.get("name") == value
        ]

    def search(self, model, domain, fields=None, limit=None):
        self._ensure(model)
        out = [
            rid for rid, v in self.records[model].items() if self._match(v, domain, rid)
        ]
        return out[:limit] if limit else out

    def search_read(self, model, domain, fields, limit=None):
        self._ensure(model)
        res = []
        for rid, v in self.records[model].items():
            if not self._match(v, domain, rid):
                continue
            rec = {"id": rid}
            for f in fields:
                rec[f] = v.get(f) if v.get(f) is not None else False
            res.append(rec)
        return res[:limit] if limit else res

    def _match(self, v, domain, rid):
        for f, op, val in domain:
            rv = rid if f == "id" else v.get(f)
            if op == "=" and rv != val:
                return False
            if op == "in" and rv not in val:
                return False
        return True


class TestMainValidateHandler(unittest.TestCase):
    def setUp(self):
        self.backend = _Backend()
        self.backend.field_info_map["res.partner"] = {
            "name": FieldInfo("name", "char"),
            "ref": FieldInfo("ref", "char"),
        }
        self.emitted = []
        self._orig_emit = mainmod._emit
        self._orig_backend = mainmod._get_backend
        mainmod._emit = lambda d: self.emitted.append(d)
        mainmod._get_backend = lambda cmd, **kw: self.backend

    def tearDown(self):
        mainmod._emit = self._orig_emit
        mainmod._get_backend = self._orig_backend

    def _cmd(self, rows, **extra):
        c = {
            "model": "res.partner",
            "field_mappings": {"Ref": "ref", "N": "name"},
            "search_keys": ["ref"],
            "raw_rows": rows,
        }
        c.update(extra)
        return c

    def test_emits_validation_report(self):
        self.backend.create("res.partner", {"ref": "R1", "name": "Alice"})
        mainmod._handle_validate(self._cmd([{"Ref": "R1", "N": "Alice"}]))
        self.assertEqual(len(self.emitted), 1)
        msg = self.emitted[0]
        self.assertEqual(msg["type"], "validation")
        self.assertEqual(msg["report"]["checked"], 1)
        self.assertEqual(msg["report"]["ok"], 1)
        self.assertEqual(msg["report"]["failedRows"], 0)

    def test_reports_dropped_field(self):
        self.backend.create("res.partner", {"ref": "R2", "name": False})  # empty in DB
        mainmod._handle_validate(self._cmd([{"Ref": "R2", "N": "Bob"}]))
        rep = self.emitted[0]["report"]
        self.assertEqual(rep["failedRows"], 1)
        fields = [m["field"] for m in rep["mismatches"]]
        self.assertIn("name", fields)

    def test_skip_indices_excludes_row(self):
        self.backend.create("res.partner", {"ref": "R3", "name": "C"})
        mainmod._handle_validate(self._cmd([{"Ref": "R3", "N": "C"}], skip_indices=[1]))
        self.assertEqual(self.emitted[0]["report"]["checked"], 0)

    def test_batches_all_rows(self):
        for r in ("A", "B", "C"):
            self.backend.create("res.partner", {"ref": r, "name": r})
        mainmod._handle_validate(
            self._cmd(
                [
                    {"Ref": "A", "N": "A"},
                    {"Ref": "B", "N": "B"},
                    {"Ref": "C", "N": "C"},
                ],
                batch_size=1,  # force one validate_rows call per row, merged
            )
        )
        rep = self.emitted[0]["report"]
        self.assertEqual(rep["checked"], 3)
        self.assertEqual(rep["ok"], 3)

    def test_error_path_emits_error(self):
        def boom(cmd, **kw):
            raise RuntimeError("no backend")

        mainmod._get_backend = boom
        mainmod._handle_validate(self._cmd([{"Ref": "R1", "N": "x"}]))
        self.assertEqual(self.emitted[0]["type"], "error")
        self.assertIn("no backend", self.emitted[0]["message"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
