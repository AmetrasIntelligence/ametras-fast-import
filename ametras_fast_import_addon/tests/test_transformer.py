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

    def test_parses_delimited_relational_ids_to_list(self):
        """A many2many /.id may carry multiple ids (comma or pipe) — like
        Odoo model.load. taxes_id/.id = '173,213' -> [173, 213]."""
        self.assertEqual(
            transform_row_data({"col": "173,213"}, {"col": "taxes_id/.id"}),
            {"taxes_id": [173, 213]},
        )
        self.assertEqual(
            transform_row_data({"col": "6|7|8"}, {"col": "route_ids/.id"}),
            {"route_ids": [6, 7, 8]},
        )

    def test_single_relational_id_stays_int(self):
        self.assertEqual(
            transform_row_data({"col": "173"}, {"col": "taxes_id/.id"}),
            {"taxes_id": 173},
        )

    def test_raises_on_non_numeric_in_delimited_ids(self):
        with self.assertRaises(ValueError) as ctx:
            transform_row_data({"col": "173,abc"}, {"col": "taxes_id/.id"})
        self.assertIn("database id", str(ctx.exception).lower())


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


class TestTransformNumericNormalization(unittest.TestCase):
    """Typed values from the JSON raw_rows API are normalised.

    CSV always delivers strings, so these only bite the raw_rows path where a
    client (or a spreadsheet lib) sends real JSON numbers.
    """

    def test_integral_float_defloated_to_int_string(self):
        """272.0 must not reach a Char as "272.0" (silent formatting corruption)."""
        result = transform_row_data({"c": 272.0}, {"c": "manufacturer_ref"})
        self.assertEqual(result, {"manufacturer_ref": "272"})

    def test_bare_int_stringified_as_reference(self):
        """A bare numeric is a reference, not a db id — stringified for resolve_row.

        This is the #3 guard: a manufacturer *number* sent as int 272 must NOT
        be treated as database id 272 (silent wrong-link). Only `/.id` opts into
        db-id semantics.
        """
        result = transform_row_data({"c": 272}, {"c": "manufacturer_id"})
        self.assertEqual(result, {"manufacturer_id": "272"})
        self.assertIsInstance(result["manufacturer_id"], str)

    def test_dotid_still_kept_as_int(self):
        """The explicit /.id opt-in keeps db-id (int) semantics."""
        result = transform_row_data({"c": 272}, {"c": "manufacturer_id/.id"})
        self.assertEqual(result, {"manufacturer_id": 272})
        self.assertIsInstance(result["manufacturer_id"], int)

    def test_fractional_float_passes_through(self):
        """A genuine fractional float is left for Odoo to convert."""
        result = transform_row_data({"c": 95.5}, {"c": "list_price"})
        self.assertEqual(result, {"list_price": 95.5})

    def test_string_numbers_unchanged(self):
        """CSV-style string numbers are untouched (no accidental retyping)."""
        result = transform_row_data({"c": "007"}, {"c": "default_code"})
        self.assertEqual(result, {"default_code": "007"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
