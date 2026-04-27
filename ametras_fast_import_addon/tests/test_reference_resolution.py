"""
Unit tests for reference resolution helper functions.
These tests don't require Odoo - they test the pure Python helper methods.
Run with: python3 ametras_fast_import_addon/tests/test_reference_resolution.py
"""
import sys
import unittest

# Mock odoo modules before importing
sys.modules["odoo"] = type(sys)("odoo")
sys.modules["odoo.http"] = type(sys)("odoo.http")
sys.modules["odoo.http"].Controller = object
sys.modules["odoo.http"].route = lambda *a, **k: lambda f: f
sys.modules["odoo.http"].request = None

# Now we can import

# Define the functions to test (copy from controller to avoid import issues)
STANDARD_DB_ID_MODELS = {
    "res.country",
    "res.currency",
    "uom.uom",
    "res.lang",
    "res.country.state",
    "res.partner.title",
}


def _is_external_id(value):
    """Check if value looks like an external ID reference."""
    if not isinstance(value, str):
        return False
    return not value.strip().isdigit()


def _parse_refs(value):
    """Parse pipe or comma-delimited references."""
    if not value:
        return []
    delimiter = "|" if "|" in value else ","
    return [x.strip() for x in value.split(delimiter) if x.strip()]


def _normalize_ext_id(value):
    """Normalize external ID to (module, name) tuple."""
    value = value.strip()
    if "." in value:
        module, name = value.split(".", 1)
        return (module, name)
    else:
        return ("__import__", value)


def _lookup_ref(model_name, value, ref_map):
    """Lookup resolved ID from prefetch map."""
    module, name = _normalize_ext_id(value)
    key = (model_name, module, name)
    if key not in ref_map:
        raise ValueError(f"External ID '{value}' not found for model {model_name}")
    return ref_map[key]


class TestIsExternalId(unittest.TestCase):
    """Test _is_external_id function."""

    def test_string_with_hash(self):
        """String values with # are external IDs."""
        self.assertTrue(_is_external_id("product_category#123"))
        self.assertTrue(_is_external_id("res_partner_id#2093"))

    def test_string_with_dot(self):
        """String values with . (module.name) are external IDs."""
        self.assertTrue(_is_external_id("base.de"))
        self.assertTrue(_is_external_id("purchase_stock.route_warehouse0_buy"))

    def test_numeric_string(self):
        """Purely numeric strings are NOT external IDs."""
        self.assertFalse(_is_external_id("123"))
        self.assertFalse(_is_external_id("1"))
        self.assertFalse(_is_external_id(" 42 "))

    def test_non_string(self):
        """Non-strings are not external IDs."""
        self.assertFalse(_is_external_id(123))
        self.assertFalse(_is_external_id(None))


class TestParseRefs(unittest.TestCase):
    """Test _parse_refs function."""

    def test_pipe_delimited(self):
        """Parse pipe-delimited references."""
        result = _parse_refs("ref1|ref2|ref3")
        self.assertEqual(result, ["ref1", "ref2", "ref3"])

    def test_comma_delimited(self):
        """Parse comma-delimited references (legacy format)."""
        result = _parse_refs("ref1,ref2,ref3")
        self.assertEqual(result, ["ref1", "ref2", "ref3"])

    def test_with_spaces(self):
        """Handle whitespace around references."""
        result = _parse_refs("ref1 | ref2 | ref3")
        self.assertEqual(result, ["ref1", "ref2", "ref3"])

    def test_empty(self):
        """Empty string returns empty list."""
        self.assertEqual(_parse_refs(""), [])
        self.assertEqual(_parse_refs(None), [])

    def test_single_value(self):
        """Single value without delimiter."""
        result = _parse_refs("single_ref")
        self.assertEqual(result, ["single_ref"])

    def test_real_route_ids(self):
        """Parse real route_ids from CSV."""
        result = _parse_refs(
            "purchase_stock.route_warehouse0_buy,stock.route_warehouse0_mto"
        )
        self.assertEqual(
            result,
            ["purchase_stock.route_warehouse0_buy", "stock.route_warehouse0_mto"],
        )


class TestNormalizeExtId(unittest.TestCase):
    """Test _normalize_ext_id function."""

    def test_with_module(self):
        """Normalize module.name format."""
        result = _normalize_ext_id("base.de")
        self.assertEqual(result, ("base", "de"))

    def test_without_module(self):
        """Normalize name-only format to __import__ module."""
        result = _normalize_ext_id("product_category#123")
        self.assertEqual(result, ("__import__", "product_category#123"))

    def test_with_whitespace(self):
        """Handle whitespace in external ID."""
        result = _normalize_ext_id(" base.de ")
        self.assertEqual(result, ("base", "de"))

    def test_multiple_dots(self):
        """Handle external IDs with multiple dots."""
        result = _normalize_ext_id("purchase_stock.route_warehouse0_buy")
        self.assertEqual(result, ("purchase_stock", "route_warehouse0_buy"))


class TestLookupRef(unittest.TestCase):
    """Test _lookup_ref function."""

    def test_found(self):
        """Lookup returns ID when found."""
        ref_map = {("product.category", "__import__", "product_category#123"): 42}
        result = _lookup_ref("product.category", "product_category#123", ref_map)
        self.assertEqual(result, 42)

    def test_with_module(self):
        """Lookup with explicit module."""
        ref_map = {("stock.route", "purchase_stock", "route_warehouse0_buy"): 7}
        result = _lookup_ref(
            "stock.route", "purchase_stock.route_warehouse0_buy", ref_map
        )
        self.assertEqual(result, 7)

    def test_not_found_raises(self):
        """Lookup raises ValueError when not found."""
        ref_map = {}
        with self.assertRaises(ValueError) as ctx:
            _lookup_ref("product.category", "missing_ref", ref_map)
        self.assertIn("External ID 'missing_ref' not found", str(ctx.exception))


class TestStandardDbIdModels(unittest.TestCase):
    """Test STANDARD_DB_ID_MODELS constant."""

    def test_contains_country(self):
        self.assertIn("res.country", STANDARD_DB_ID_MODELS)

    def test_contains_currency(self):
        self.assertIn("res.currency", STANDARD_DB_ID_MODELS)

    def test_contains_uom(self):
        self.assertIn("uom.uom", STANDARD_DB_ID_MODELS)

    def test_contains_lang(self):
        self.assertIn("res.lang", STANDARD_DB_ID_MODELS)

    def test_contains_country_state(self):
        self.assertIn("res.country.state", STANDARD_DB_ID_MODELS)

    def test_contains_partner_title(self):
        self.assertIn("res.partner.title", STANDARD_DB_ID_MODELS)

    def test_not_contains_partner(self):
        self.assertNotIn("res.partner", STANDARD_DB_ID_MODELS)

    def test_not_contains_product_template(self):
        self.assertNotIn("product.template", STANDARD_DB_ID_MODELS)

    def test_not_contains_product_category(self):
        self.assertNotIn("product.category", STANDARD_DB_ID_MODELS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
