"""
Unit tests for row transformation.
Port of vue-app/tests/unit/rowTransform.test.ts — identical test cases.
Run with: python3 ametras_fast_import_addon/tests/test_transformer.py
  or: python3 -m pytest ametras_fast_import_addon/tests/ -v
"""
import unittest
import sys
import os

# Add the import_engine package directly to path (avoids loading the Odoo addon)
_engine_path = os.path.join(os.path.dirname(__file__), '..', 'models')
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.transformer import transform_row_data


class TestTransformRowDataDatabaseId(unittest.TestCase):
    """.id field (database ID)"""

    def test_parses_numeric_id_values(self):
        result = transform_row_data({'col': '42'}, {'col': '.id'})
        self.assertEqual(result, {'id': 42})

    def test_skips_id_when_non_numeric(self):
        result = transform_row_data({'col': 'abc'}, {'col': '.id'})
        self.assertEqual(result, {})
        self.assertNotIn('id', result)

    def test_skips_id_when_empty(self):
        result = transform_row_data({'col': ''}, {'col': '.id'})
        self.assertEqual(result, {})


class TestTransformRowDataRelationalDatabaseId(unittest.TestCase):
    """/.id relational field (database ID)"""

    def test_parses_numeric_relational_id(self):
        result = transform_row_data({'col': '7'}, {'col': 'partner_id/.id'})
        self.assertEqual(result, {'partner_id': 7})

    def test_skips_relational_id_when_non_numeric(self):
        result = transform_row_data({'col': 'not_a_number'}, {'col': 'partner_id/.id'})
        self.assertEqual(result, {})
        self.assertNotIn('partner_id', result)

    def test_skips_relational_id_when_empty(self):
        result = transform_row_data({'col': ''}, {'col': 'partner_id/.id'})
        self.assertEqual(result, {})


class TestTransformRowDataOtherFields(unittest.TestCase):
    """Other fields"""

    def test_passes_through_regular_fields(self):
        result = transform_row_data({'col': 'hello'}, {'col': 'name'})
        self.assertEqual(result, {'name': 'hello'})

    def test_handles_external_id_field(self):
        result = transform_row_data({'col': 'ext_123'}, {'col': 'id'})
        self.assertEqual(result, {'__external_id__': 'ext_123'})

    def test_handles_relational_external_id(self):
        result = transform_row_data({'col': 'ext_ref'}, {'col': 'partner_id/id'})
        self.assertEqual(result, {'partner_id': 'ext_ref'})

    def test_handles_op_column(self):
        result = transform_row_data({'col': 'create'}, {'col': '__op__'})
        self.assertEqual(result, {'__op__': 'create'})

    def test_skips_empty_values(self):
        result = transform_row_data(
            {'a': 'hello', 'b': '', 'c': 'world'},
            {'a': 'name', 'b': 'email', 'c': 'phone'}
        )
        self.assertEqual(result, {'name': 'hello', 'phone': 'world'})

    def test_skips_missing_columns(self):
        result = transform_row_data(
            {'a': 'hello'},
            {'a': 'name', 'b': 'email'}
        )
        self.assertEqual(result, {'name': 'hello'})

    def test_multiple_fields(self):
        result = transform_row_data(
            {'Name': 'Acme', 'Code': 'ACM', 'ExtID': 'cust_001', 'Country': 'base.de'},
            {'Name': 'name', 'Code': 'default_code', 'ExtID': 'id', 'Country': 'country_id/id'}
        )
        self.assertEqual(result, {
            'name': 'Acme',
            'default_code': 'ACM',
            '__external_id__': 'cust_001',
            'country_id': 'base.de',
        })


if __name__ == '__main__':
    unittest.main(verbosity=2)
