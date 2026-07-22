"""
Unit tests for scalar type coercion (import_engine.coercion).

Focus: booleans, because the fast importer wrote raw CSV strings straight into
create/write, and Odoo's Boolean.convert_to_column does bool(value) — so "0"
(a truthy non-empty string) was stored as True and silently corrupted data.

Run with: python3 ametras_fast_import_addon/tests/test_coercion.py
  or: python3 -m pytest ametras_fast_import_addon/tests/ -v
"""
import os
import sys
import unittest

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.coercion import coerce_boolean, coerce_selection


class TestCoerceBooleanFalseStrings(unittest.TestCase):
    """The core bug: falsey CSV strings must become False, not True."""

    def test_string_zero_is_false(self):
        # THE ticket case: bool("0") is True; coerce_boolean("0") must be False.
        self.assertIs(coerce_boolean("0"), False)

    def test_false_word_variants(self):
        for value in ("false", "False", "FALSE", "no", "No", "NO"):
            self.assertIs(coerce_boolean(value), False, value)

    def test_empty_string_is_false(self):
        # Mirrors ir_fields._str_to_boolean: "" -> False (unchecked box).
        self.assertIs(coerce_boolean(""), False)

    def test_surrounding_whitespace(self):
        self.assertIs(coerce_boolean("  0  "), False)
        self.assertIs(coerce_boolean("\tno\n"), False)


class TestCoerceBooleanTrueStrings(unittest.TestCase):
    def test_string_one_is_true(self):
        self.assertIs(coerce_boolean("1"), True)

    def test_true_word_variants(self):
        for value in ("true", "True", "TRUE", "yes", "Yes", "YES"):
            self.assertIs(coerce_boolean(value), True, value)

    def test_surrounding_whitespace(self):
        self.assertIs(coerce_boolean("  1 "), True)
        self.assertIs(coerce_boolean(" YES "), True)


class TestCoerceBooleanNonStrings(unittest.TestCase):
    def test_already_bool_passthrough(self):
        self.assertIs(coerce_boolean(True), True)
        self.assertIs(coerce_boolean(False), False)

    def test_int(self):
        self.assertIs(coerce_boolean(1), True)
        self.assertIs(coerce_boolean(0), False)
        self.assertIs(coerce_boolean(5), True)

    def test_float(self):
        self.assertIs(coerce_boolean(1.0), True)
        self.assertIs(coerce_boolean(0.0), False)

    def test_none_is_false(self):
        self.assertIs(coerce_boolean(None), False)


class TestCoerceBooleanUnknown(unittest.TestCase):
    """Unknown tokens raise (a per-row error) instead of silently guessing."""

    def test_unknown_string_raises(self):
        for value in ("maybe", "2", "-1", "oui", "y", "n", "on", "off"):
            with self.assertRaises(ValueError, msg=value):
                coerce_boolean(value)

    def test_error_message_is_actionable(self):
        with self.assertRaises(ValueError) as ctx:
            coerce_boolean("maybe")
        msg = str(ctx.exception)
        self.assertIn("maybe", msg)
        self.assertIn("boolean", msg)

    def test_unsupported_type_raises(self):
        with self.assertRaises(ValueError):
            coerce_boolean(["1"])
        with self.assertRaises(ValueError):
            coerce_boolean({"a": 1})


class TestCoerceSelection(unittest.TestCase):
    SEL = [("draft", "Draft"), ("done", "Done"), ("invoice", "Invoice Address")]

    def test_key_passes_through(self):
        self.assertEqual(coerce_selection("draft", self.SEL), "draft")

    def test_label_maps_to_key(self):
        self.assertEqual(coerce_selection("Draft", self.SEL), "draft")
        self.assertEqual(coerce_selection("Invoice Address", self.SEL), "invoice")

    def test_label_case_insensitive_and_trimmed(self):
        self.assertEqual(coerce_selection("  DONE  ", self.SEL), "done")
        self.assertEqual(coerce_selection("invoice address", self.SEL), "invoice")

    def test_unknown_passes_through_for_odoo_to_reject(self):
        # Neither key nor label -> unchanged; Odoo raises the loud per-row error.
        self.assertEqual(coerce_selection("bogus", self.SEL), "bogus")

    def test_no_selection_metadata_passes_through(self):
        self.assertEqual(coerce_selection("Draft", None), "Draft")

    def test_non_string_passes_through(self):
        self.assertEqual(coerce_selection(5, self.SEL), 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
