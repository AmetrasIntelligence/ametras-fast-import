"""
Tests for post-import validation (validator.py + Importer.validate_rows).

Covers the type-aware comparison and the re-derive-and-read-back flow, including
the IHX-9177 shape: an import that "succeeded" but left a field empty must be
reported as a `dropped` mismatch. Pure Python — runs standalone in CI.

Run with: python3 ametras_fast_import_addon/tests/test_validator.py
"""
import os
import sys
import unittest

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.backend import FieldInfo, OdooBackend
from import_engine.importer import ImportConfig, Importer
from import_engine.parser import ParsedRow
from import_engine.validator import is_empty, values_match


class TestValuesMatch(unittest.TestCase):
    def test_char_exact(self):
        self.assertTrue(values_match("char", "Acme", "Acme"))
        self.assertFalse(values_match("char", "Acme", "Acme GmbH"))

    def test_char_dropped_is_mismatch(self):
        # intended a value, DB empty -> the silent-drop shape
        self.assertFalse(values_match("char", "Acme", False))
        self.assertFalse(values_match("char", "Acme", None))

    def test_both_empty_match(self):
        self.assertTrue(values_match("char", "", False))
        self.assertTrue(values_match("many2one", False, False))

    def test_integer_representation_insensitive(self):
        self.assertTrue(values_match("integer", "5", 5))
        self.assertTrue(values_match("integer", 5, 5))
        self.assertFalse(values_match("integer", "5", 6))

    def test_float_tolerance(self):
        self.assertTrue(values_match("float", "95.70", 95.7))
        self.assertTrue(values_match("monetary", 95.7000001, 95.7))
        self.assertFalse(values_match("float", "95.70", 96.0))

    def test_boolean(self):
        self.assertTrue(values_match("boolean", "0", False))
        self.assertTrue(values_match("boolean", "1", True))
        self.assertFalse(values_match("boolean", "1", False))

    def test_many2one_stored_as_pair(self):
        # search_read returns m2o as [id, display_name]
        self.assertTrue(values_match("many2one", 7, [7, "Some Partner"]))
        self.assertFalse(values_match("many2one", 7, [8, "Other"]))
        self.assertFalse(values_match("many2one", 7, False))  # dropped

    def test_many2many_command_vs_id_list(self):
        self.assertTrue(values_match("many2many", [(6, 0, [1, 2])], [2, 1]))
        self.assertFalse(values_match("many2many", [(6, 0, [1, 2])], [1]))

    def test_selection_key(self):
        self.assertTrue(values_match("selection", "invoice", "invoice"))
        self.assertFalse(values_match("selection", "invoice", "contact"))

    def test_date_widened_to_datetime(self):
        self.assertTrue(values_match("date", "2026-07-23", "2026-07-23 00:00:00"))
        self.assertFalse(values_match("date", "2026-07-23", "2026-07-24"))

    def test_is_empty(self):
        for v in (None, False, "", [], (), {}):
            self.assertTrue(is_empty(v))
        for v in ("x", 0.0 + 1, [1], "0"):
            self.assertFalse(is_empty(v))


class _ValidatorBackend(OdooBackend):
    """In-memory backend whose search_read returns m2o as [id, name] pairs."""

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

    def execute(self, model, method, *args, **kwargs):
        return None

    def get_field_info(self, model):
        return self.field_info_map.get(model, {})

    def browse_exists(self, model, record_id):
        self._ensure(model)
        return record_id in self.records[model]

    def name_search(self, model, value):
        self._ensure(model)
        return [
            (rid, vals.get("name"))
            for rid, vals in self.records[model].items()
            if vals.get("name") == value
        ]

    def search(self, model, domain, fields=None, limit=None):
        self._ensure(model)
        out = [
            rid for rid, v in self.records[model].items() if self._match(v, domain, rid)
        ]
        return out[:limit] if limit else out

    def search_read(self, model, domain, fields, limit=None):
        self._ensure(model)
        info = self.field_info_map.get(model, {})
        results = []
        for rid, vals in self.records[model].items():
            if not self._match(vals, domain, rid):
                continue
            rec = {"id": rid}
            for f in fields:
                v = vals.get(f)
                # emulate Odoo search_read: m2o -> [id, name]
                ftype = info[f].type if f in info else "char"
                if (
                    ftype == "many2one"
                    and isinstance(v, int)
                    and not isinstance(v, bool)
                ):
                    name = (
                        self.records.get(info[f].comodel_name, {})
                        .get(v, {})
                        .get("name", str(v))
                    )
                    rec[f] = [v, name]
                elif ftype == "many2many":
                    rec[f] = self._m2m_ids(v)
                else:
                    rec[f] = v if v is not None else False
            results.append(rec)
        return results[:limit] if limit else results

    @staticmethod
    def _m2m_ids(v):
        if isinstance(v, list) and v and isinstance(v[0], (list, tuple)):
            ids = []
            for cmd in v:
                if cmd[0] == 6:
                    ids.extend(cmd[2])
            return ids
        return v or []

    def _match(self, vals, domain, rid):
        for f, op, val in domain:
            rv = rid if f == "id" else vals.get(f)
            if op == "=" and rv != val:
                return False
            if op == "in" and rv not in val:
                return False
        return True


class TestValidateRowsEndToEnd(unittest.TestCase):
    """Re-derive + read-back through the real Importer.validate_rows()."""

    def _setup(self):
        backend = _ValidatorBackend()
        backend.field_info_map["product.template"] = {
            "default_code": FieldInfo("default_code", "char"),
            "name": FieldInfo("name", "char"),
            "manufacturer_id": FieldInfo("manufacturer_id", "many2one", "res.partner"),
        }
        # a manufacturer partner resolvable by name
        backend.field_info_map["res.partner"] = {"name": FieldInfo("name", "char")}
        backend.create("res.partner", {"name": "Ravaglioli"})
        return backend

    def _importer(self, backend):
        # search on default_code is the natural key -> update-able + locatable
        config = ImportConfig(
            model="product.template",
            field_mappings={
                "Code": "default_code",
                "Name": "name",
                "Hersteller": "manufacturer_id",
            },
            search_keys=["default_code"],
        )
        return Importer(backend, config)

    def test_clean_import_validates_ok(self):
        backend = self._setup()
        importer = self._importer(backend)
        rows = [
            ParsedRow(
                index=1,
                data={"Code": "P1", "Name": "Prod 1", "Hersteller": "Ravaglioli"},
            )
        ]
        importer.import_rows(rows)
        report = importer.validate_rows(rows)
        self.assertEqual(report.checked, 1)
        self.assertEqual(report.ok, 1)
        self.assertFalse(report.failed)
        self.assertEqual(report.mismatches, [])

    def test_dropped_manufacturer_is_reported(self):
        """The IHX-9177 shape: record exists but the m2o was silently emptied."""
        backend = self._setup()
        importer = self._importer(backend)
        rows = [
            ParsedRow(
                index=1,
                data={"Code": "P1", "Name": "Prod 1", "Hersteller": "Ravaglioli"},
            )
        ]
        importer.import_rows(rows)
        # Simulate a silent drop: the stored record lost its manufacturer.
        rec_id = backend.search("product.template", [("default_code", "=", "P1")])[0]
        backend.records["product.template"][rec_id]["manufacturer_id"] = False

        report = importer.validate_rows(rows)
        self.assertEqual(report.checked, 1)
        self.assertEqual(report.ok, 0)
        self.assertTrue(report.failed)
        self.assertEqual(len(report.mismatches), 1)
        m = report.mismatches[0]
        self.assertEqual(m.field_name, "manufacturer_id")
        self.assertEqual(m.kind, "dropped")

    def test_pure_create_is_unvalidatable_not_silent(self):
        """A create with no stable key can't be re-located → reported, not skipped."""
        backend = _ValidatorBackend()
        backend.field_info_map["product.template"] = {
            "name": FieldInfo("name", "char"),
        }
        config = ImportConfig(
            model="product.template",
            field_mappings={"Name": "name"},  # no search key, no id
        )
        importer = Importer(backend, config)
        rows = [ParsedRow(index=1, data={"Name": "Prod 1"})]
        importer.import_rows(rows)
        report = importer.validate_rows(rows)
        self.assertEqual(report.checked, 0)
        self.assertEqual(len(report.unvalidatable), 1)
        self.assertEqual(report.unvalidatable[0][0], 1)

    def test_m2m_dotid_roundtrip_validates(self):
        """End-to-end: a many2many /.id ("173,213") re-derives to a (6,0,[ids])
        command and validates against the stored id list; a dropped id fails."""
        backend = _ValidatorBackend()
        backend.field_info_map["product.template"] = {
            "default_code": FieldInfo("default_code", "char"),
            "taxes_id": FieldInfo("taxes_id", "many2many", "account.tax"),
        }
        rid = backend.create(
            "product.template", {"default_code": "P1", "taxes_id": [173, 213]}
        )
        config = ImportConfig(
            model="product.template",
            field_mappings={"Code": "default_code", "Taxes": "taxes_id/.id"},
            search_keys=["default_code"],
        )
        importer = Importer(backend, config)
        rows = [ParsedRow(index=1, data={"Code": "P1", "Taxes": "173,213"})]

        report = importer.validate_rows(rows)
        self.assertEqual(report.checked, 1)
        self.assertEqual(report.ok, 1)
        self.assertFalse(report.failed)

        # Drop one tax in the DB -> mismatch on taxes_id.
        backend.records["product.template"][rid]["taxes_id"] = [173]
        report2 = importer.validate_rows(rows)
        self.assertTrue(report2.failed)
        self.assertEqual(report2.mismatches[0].field_name, "taxes_id")

    def test_report_to_dict_shape(self):
        backend = self._setup()
        importer = self._importer(backend)
        rows = [
            ParsedRow(
                index=1,
                data={"Code": "P1", "Name": "Prod 1", "Hersteller": "Ravaglioli"},
            )
        ]
        importer.import_rows(rows)
        rec_id = backend.search("product.template", [("default_code", "=", "P1")])[0]
        backend.records["product.template"][rec_id]["name"] = "Changed"
        d = importer.validate_rows(rows).to_dict()
        self.assertEqual(d["model"], "product.template")
        self.assertEqual(d["checked"], 1)
        self.assertEqual(d["failedRows"], 1)
        self.assertEqual(d["mismatches"][0]["field"], "name")
        self.assertIn("unvalidatable", d)


if __name__ == "__main__":
    unittest.main(verbosity=2)
