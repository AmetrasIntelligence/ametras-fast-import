"""
Unit tests for row transformation.
Port of vue-app/tests/unit/rowTransform.test.ts — identical test cases.
Run with: python3 ametras_fast_import_addon/tests/test_transformer.py
  or: python3 -m pytest ametras_fast_import_addon/tests/ -v
"""
import os
import sys
import unittest

# Add the import_engine package directly to path (avoids loading the Odoo addon)
_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.transformer import transform_row_data


class TestTransformRowDataDatabaseId(unittest.TestCase):
    """.id field (database ID)"""

    def test_parses_numeric_id_values(self):
        result = transform_row_data({"col": "42"}, {"col": ".id"})
        self.assertEqual(result, {"id": 42})

    def test_raises_on_non_numeric_id(self):
        """A present-but-non-numeric .id raises (was silently dropped -> dup)."""
        with self.assertRaises(ValueError) as ctx:
            transform_row_data({"col": "abc"}, {"col": ".id"})
        self.assertIn("database id", str(ctx.exception).lower())

    def test_skips_id_when_empty(self):
        result = transform_row_data({"col": ""}, {"col": ".id"})
        self.assertEqual(result, {})


class TestTransformRowDataRelationalDatabaseId(unittest.TestCase):
    """/.id relational field (database ID)"""

    def test_parses_numeric_relational_id(self):
        result = transform_row_data({"col": "7"}, {"col": "partner_id/.id"})
        self.assertEqual(result, {"partner_id": 7})

    def test_raises_on_non_numeric_relational_id(self):
        """A present-but-non-numeric <field>/.id raises rather than dropping."""
        with self.assertRaises(ValueError) as ctx:
            transform_row_data({"col": "not_a_number"}, {"col": "partner_id/.id"})
        self.assertIn("database id", str(ctx.exception).lower())

    def test_skips_relational_id_when_empty(self):
        result = transform_row_data({"col": ""}, {"col": "partner_id/.id"})
        self.assertEqual(result, {})


class TestTransformRowDataOtherFields(unittest.TestCase):
    """Other fields"""

    def test_passes_through_regular_fields(self):
        result = transform_row_data({"col": "hello"}, {"col": "name"})
        self.assertEqual(result, {"name": "hello"})

    def test_handles_external_id_field(self):
        result = transform_row_data({"col": "ext_123"}, {"col": "id"})
        self.assertEqual(result, {"__external_id__": "ext_123"})

    def test_handles_relational_external_id(self):
        result = transform_row_data({"col": "ext_ref"}, {"col": "partner_id/id"})
        self.assertEqual(result, {"partner_id": "ext_ref"})

    def test_handles_op_column(self):
        result = transform_row_data({"col": "create"}, {"col": "__op__"})
        self.assertEqual(result, {"__op__": "create"})

    def test_keeps_empty_values_for_regular_fields(self):
        """Empty regular-field cells are now FORWARDED.

        The transformer can't know a field's type, so it forwards empty cells
        for regular fields and lets resolve_row decide what an empty cell means
        (empty boolean -> False; empty of any other type -> dropped there). An
        absent column is still omitted entirely.
        """
        result = transform_row_data(
            {"a": "hello", "b": "", "c": "world"},
            {"a": "name", "b": "flag", "c": "phone"},
        )
        self.assertEqual(result, {"name": "hello", "flag": "", "phone": "world"})

    def test_skips_missing_columns(self):
        """A column absent from the row is omitted (distinct from an empty cell)."""
        result = transform_row_data({"a": "hello"}, {"a": "name", "b": "email"})
        self.assertEqual(result, {"name": "hello"})
        self.assertNotIn("email", result)

    def test_skips_empty_special_columns(self):
        """Empty cells in special columns carry no meaning and are skipped.

        (External id / db id / operation / relational refs — an empty cell there
        must never produce an empty external id, op string, or relation.)
        """
        result = transform_row_data(
            {
                "ext": "",
                "op": "",
                "rel_ext": "",
                "rel_db": "",
                "dbid": "",
                "kept": "value",
            },
            {
                "ext": "id",
                "op": "__op__",
                "rel_ext": "partner_id/id",
                "rel_db": "partner_id/.id",
                "dbid": ".id",
                "kept": "name",
            },
        )
        self.assertEqual(result, {"name": "value"})

    def test_multiple_fields(self):
        result = transform_row_data(
            {"Name": "Acme", "Code": "ACM", "ExtID": "cust_001", "Country": "base.de"},
            {
                "Name": "name",
                "Code": "default_code",
                "ExtID": "id",
                "Country": "country_id/id",
            },
        )
        self.assertEqual(
            result,
            {
                "name": "Acme",
                "default_code": "ACM",
                "__external_id__": "cust_001",
                "country_id": "base.de",
            },
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
