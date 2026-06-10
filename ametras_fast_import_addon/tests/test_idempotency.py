"""
Tests for assess_timeout_retry_idempotency.

Port of 16.0's idempotency.test.ts scenarios to Python.
Run with: python3 -m pytest ametras_fast_import_addon/tests/test_idempotency.py
"""
import os
import sys
import unittest

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.idempotency import assess_timeout_retry_idempotency
from import_engine.parser import ParsedRow


def make_row(index: int, data: dict) -> ParsedRow:
    return ParsedRow(index=index, data=data)


class TestBothKeysMapped(unittest.TestCase):
    """Both 'id' and '.id' target fields are present in the mapping."""

    def setUp(self):
        self.mappings = {"ExtID": "id", "DBID": ".id", "Name": "name"}

    def test_all_rows_safe_when_all_have_ext_id(self):
        rows = [
            make_row(1, {"ExtID": "mod.rec1", "DBID": "", "Name": "A"}),
            make_row(2, {"ExtID": "mod.rec2", "DBID": "", "Name": "B"}),
        ]
        result = assess_timeout_retry_idempotency(rows, self.mappings)
        self.assertEqual(len(result.safe), 2)
        self.assertEqual(len(result.unsafe), 0)

    def test_all_rows_safe_when_all_have_db_id(self):
        rows = [
            make_row(1, {"ExtID": "", "DBID": "42", "Name": "A"}),
            make_row(2, {"ExtID": "", "DBID": "99", "Name": "B"}),
        ]
        result = assess_timeout_retry_idempotency(rows, self.mappings)
        self.assertEqual(len(result.safe), 2)
        self.assertEqual(len(result.unsafe), 0)

    def test_split_some_rows_have_neither(self):
        rows = [
            make_row(1, {"ExtID": "mod.rec1", "DBID": "", "Name": "A"}),
            make_row(2, {"ExtID": "", "DBID": "", "Name": "B"}),  # unsafe
            make_row(3, {"ExtID": "", "DBID": "7", "Name": "C"}),
        ]
        result = assess_timeout_retry_idempotency(rows, self.mappings)
        self.assertEqual(len(result.safe), 2)
        self.assertEqual(len(result.unsafe), 1)
        self.assertEqual(result.unsafe[0].index, 2)
        self.assertIn("empty_external_and_database_id", result.reason_counts)
        self.assertEqual(result.reason_counts["empty_external_and_database_id"], 1)


class TestOnlyExtIdMapped(unittest.TestCase):
    """Only 'id' is a target field — '.id' not in mappings."""

    def setUp(self):
        self.mappings = {"MyExtID": "id", "Name": "name"}

    def test_all_safe_when_all_have_value(self):
        rows = [
            make_row(1, {"MyExtID": "mod.x", "Name": "A"}),
            make_row(2, {"MyExtID": "mod.y", "Name": "B"}),
        ]
        result = assess_timeout_retry_idempotency(rows, self.mappings)
        self.assertEqual(len(result.safe), 2)
        self.assertEqual(len(result.unsafe), 0)

    def test_unsafe_when_ext_id_empty(self):
        rows = [
            make_row(1, {"MyExtID": "", "Name": "A"}),
        ]
        result = assess_timeout_retry_idempotency(rows, self.mappings)
        self.assertEqual(len(result.safe), 0)
        self.assertEqual(len(result.unsafe), 1)

    def test_whitespace_only_is_unsafe(self):
        rows = [make_row(1, {"MyExtID": "   ", "Name": "A"})]
        result = assess_timeout_retry_idempotency(rows, self.mappings)
        self.assertEqual(len(result.unsafe), 1)


class TestNoKeyMapped(unittest.TestCase):
    """Neither 'id' nor '.id' in mappings — all rows are unsafe."""

    def setUp(self):
        self.mappings = {"Name": "name", "Email": "email"}

    def test_all_unsafe_with_correct_reason(self):
        rows = [
            make_row(i, {"Name": f"R{i}", "Email": f"r{i}@x.com"}) for i in range(1, 4)
        ]
        result = assess_timeout_retry_idempotency(rows, self.mappings)
        self.assertEqual(len(result.safe), 0)
        self.assertEqual(len(result.unsafe), 3)
        self.assertEqual(result.reason_counts.get("missing_key_mapping"), 3)

    def test_empty_mapping_all_unsafe(self):
        rows = [make_row(1, {"name": "A"})]
        result = assess_timeout_retry_idempotency(rows, {})
        self.assertEqual(len(result.unsafe), 1)
        self.assertEqual(result.reason_counts.get("missing_key_mapping"), 1)


class TestEdgeCases(unittest.TestCase):
    def test_empty_batch_returns_empty(self):
        result = assess_timeout_retry_idempotency([], {"ID": "id"})
        self.assertEqual(result.safe, [])
        self.assertEqual(result.unsafe, [])
        self.assertEqual(result.reason_counts, {})

    def test_only_dot_id_mapped(self):
        mappings = {"DBID": ".id", "Name": "name"}
        rows = [
            make_row(1, {"DBID": "5", "Name": "A"}),
            make_row(2, {"DBID": "", "Name": "B"}),
        ]
        result = assess_timeout_retry_idempotency(rows, mappings)
        self.assertEqual(len(result.safe), 1)
        self.assertEqual(len(result.unsafe), 1)
        self.assertEqual(result.safe[0].index, 1)
        self.assertEqual(result.unsafe[0].index, 2)


if __name__ == "__main__":
    unittest.main()
