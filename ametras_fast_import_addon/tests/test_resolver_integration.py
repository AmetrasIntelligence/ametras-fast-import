"""
Comprehensive tests for reference resolution:
- Pure helper unit tests (is_external_id, parse_refs, normalize_ext_id, lookup_ref)
- Constants (STANDARD_DB_ID_MODELS)
- Integration tests with mock backend (prefetch_references, resolve_row)

Run with: python3 ametras_fast_import_addon/tests/test_resolver_integration.py
"""
import os
import sys
import unittest

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.backend import FieldInfo, OdooBackend
from import_engine.resolver import (
    STANDARD_DB_ID_MODELS,
    is_external_id,
    lookup_ref,
    normalize_ext_id,
    parse_refs,
    prefetch_references,
    resolve_row,
)

# ---------------------------------------------------------------------------
# Pure Helper Unit Tests
# ---------------------------------------------------------------------------


class TestIsExternalId(unittest.TestCase):
    def test_string_with_hash(self):
        self.assertTrue(is_external_id("product_category#123"))
        self.assertTrue(is_external_id("res_partner_id#2093"))

    def test_string_with_dot(self):
        self.assertTrue(is_external_id("base.de"))
        self.assertTrue(is_external_id("purchase_stock.route_warehouse0_buy"))

    def test_numeric_string(self):
        self.assertFalse(is_external_id("123"))
        self.assertFalse(is_external_id("1"))
        self.assertFalse(is_external_id(" 42 "))

    def test_non_string(self):
        self.assertFalse(is_external_id(123))
        self.assertFalse(is_external_id(None))


class TestParseRefs(unittest.TestCase):
    def test_pipe_delimited(self):
        self.assertEqual(parse_refs("ref1|ref2|ref3"), ["ref1", "ref2", "ref3"])

    def test_comma_delimited(self):
        self.assertEqual(parse_refs("ref1,ref2,ref3"), ["ref1", "ref2", "ref3"])

    def test_with_spaces(self):
        self.assertEqual(parse_refs("ref1 | ref2 | ref3"), ["ref1", "ref2", "ref3"])

    def test_empty(self):
        self.assertEqual(parse_refs(""), [])
        self.assertEqual(parse_refs(None), [])

    def test_single_value(self):
        self.assertEqual(parse_refs("single_ref"), ["single_ref"])

    def test_real_route_ids(self):
        result = parse_refs(
            "purchase_stock.route_warehouse0_buy,stock.route_warehouse0_mto"
        )
        self.assertEqual(
            result,
            ["purchase_stock.route_warehouse0_buy", "stock.route_warehouse0_mto"],
        )


class TestNormalizeExtId(unittest.TestCase):
    def test_with_module(self):
        self.assertEqual(normalize_ext_id("base.de"), ("base", "de"))

    def test_without_module(self):
        self.assertEqual(
            normalize_ext_id("product_category#123"),
            ("__import__", "product_category#123"),
        )

    def test_with_whitespace(self):
        self.assertEqual(normalize_ext_id(" base.de "), ("base", "de"))

    def test_multiple_dots(self):
        self.assertEqual(
            normalize_ext_id("purchase_stock.route_warehouse0_buy"),
            ("purchase_stock", "route_warehouse0_buy"),
        )


class TestLookupRef(unittest.TestCase):
    def test_found(self):
        ref_map = {("product.category", "__import__", "product_category#123"): 42}
        self.assertEqual(
            lookup_ref("product.category", "product_category#123", ref_map), 42
        )

    def test_with_module(self):
        ref_map = {("stock.route", "purchase_stock", "route_warehouse0_buy"): 7}
        self.assertEqual(
            lookup_ref("stock.route", "purchase_stock.route_warehouse0_buy", ref_map), 7
        )

    def test_not_found_raises(self):
        with self.assertRaises(ValueError) as ctx:
            lookup_ref("product.category", "missing_ref", {})
        self.assertIn("External ID 'missing_ref' not found", str(ctx.exception))


class TestStandardDbIdModels(unittest.TestCase):
    def test_contains_expected(self):
        for model in [
            "res.country",
            "res.currency",
            "uom.uom",
            "res.lang",
            "res.country.state",
            "res.partner.title",
        ]:
            self.assertIn(model, STANDARD_DB_ID_MODELS)

    def test_excludes_non_standard(self):
        for model in ["res.partner", "product.template", "product.category"]:
            self.assertNotIn(model, STANDARD_DB_ID_MODELS)


# ---------------------------------------------------------------------------
# Integration Tests with Mock Backend
# ---------------------------------------------------------------------------


class MockBackend(OdooBackend):
    def __init__(self):
        self.records = {}
        self.next_id = {}

    def _ensure_model(self, model):
        if model not in self.records:
            self.records[model] = {}
            self.next_id[model] = 1

    def create(self, model, vals):
        self._ensure_model(model)
        rid = self.next_id[model]
        self.next_id[model] += 1
        self.records[model][rid] = dict(vals)
        return rid

    def search(self, model, domain, fields=None, limit=None):
        return []

    def write(self, model, ids, vals):
        return True

    def execute(self, model, method, *args, **kwargs):
        return None

    def get_field_info(self, model):
        return {}

    def search_read(self, model, domain, fields, limit=None):
        self._ensure_model(model)
        results = []
        for rid, vals in self.records[model].items():
            if self._matches(vals, domain, rid):
                rec = {"id": rid}
                for f in fields:
                    rec[f] = vals.get(f)
                results.append(rec)
        if limit:
            results = results[:limit]
        return results

    def browse_exists(self, model, record_id):
        self._ensure_model(model)
        return record_id in self.records[model]

    def _matches(self, vals, domain, rid=None):
        for cond in domain:
            field_name, op, value = cond
            if field_name == "id":
                record_value = rid
            else:
                record_value = vals.get(field_name)
            if op == "=":
                if record_value != value:
                    return False
            elif op == "in":
                if record_value not in value:
                    return False
        return True


class TestPrefetchReferences(unittest.TestCase):
    def _setup_country_refs(self, backend):
        backend.create("res.country", {"name": "Germany"})
        backend.create("res.country", {"name": "France"})
        backend.create(
            "ir.model.data",
            {
                "module": "base",
                "name": "de",
                "model": "res.country",
                "res_id": 1,
            },
        )
        backend.create(
            "ir.model.data",
            {
                "module": "base",
                "name": "fr",
                "model": "res.country",
                "res_id": 2,
            },
        )

    def test_prefetch_many2one(self):
        """Prefetch resolves many2one external IDs."""
        backend = MockBackend()
        self._setup_country_refs(backend)

        field_info = {
            "name": FieldInfo("name", "char"),
            "country_id": FieldInfo("country_id", "many2one", "res.country"),
        }
        rows = [
            {"name": "Alice", "country_id": "base.de"},
            {"name": "Bob", "country_id": "base.fr"},
        ]

        ref_map = prefetch_references(backend, "res.partner", field_info, rows)

        self.assertEqual(ref_map[("res.country", "base", "de")], 1)
        self.assertEqual(ref_map[("res.country", "base", "fr")], 2)

    def test_prefetch_many2many(self):
        """Prefetch resolves many2many pipe-delimited external IDs."""
        backend = MockBackend()
        backend.create("res.partner.category", {"name": "Cust"})
        backend.create("res.partner.category", {"name": "Vend"})
        backend.create(
            "ir.model.data",
            {
                "module": "__import__",
                "name": "tag_c",
                "model": "res.partner.category",
                "res_id": 1,
            },
        )
        backend.create(
            "ir.model.data",
            {
                "module": "__import__",
                "name": "tag_v",
                "model": "res.partner.category",
                "res_id": 2,
            },
        )

        field_info = {
            "name": FieldInfo("name", "char"),
            "category_id": FieldInfo(
                "category_id", "many2many", "res.partner.category"
            ),
        }
        rows = [{"name": "Test", "category_id": "tag_c|tag_v"}]

        ref_map = prefetch_references(backend, "res.partner", field_info, rows)

        self.assertIn(("res.partner.category", "__import__", "tag_c"), ref_map)
        self.assertIn(("res.partner.category", "__import__", "tag_v"), ref_map)

    def test_prefetch_skips_special_fields(self):
        """__external_id__, __op__, id are skipped during prefetch."""
        backend = MockBackend()
        field_info = {
            "__external_id__": FieldInfo("__external_id__", "char"),
        }
        rows = [{"__external_id__": "some_ref", "__op__": "create", "id": "42"}]

        ref_map = prefetch_references(backend, "res.partner", field_info, rows)
        self.assertEqual(ref_map, {})

    def test_prefetch_skips_numeric_values(self):
        """Numeric string values are database IDs, not external IDs."""
        backend = MockBackend()
        field_info = {
            "country_id": FieldInfo("country_id", "many2one", "res.country"),
        }
        rows = [{"country_id": "42"}]  # Numeric → not an external ID

        ref_map = prefetch_references(backend, "res.partner", field_info, rows)
        self.assertEqual(ref_map, {})

    def test_prefetch_skips_empty_values(self):
        """Empty values are not prefetched."""
        backend = MockBackend()
        field_info = {
            "country_id": FieldInfo("country_id", "many2one", "res.country"),
        }
        rows = [{"country_id": ""}, {"country_id": None}]

        ref_map = prefetch_references(backend, "res.partner", field_info, rows)
        self.assertEqual(ref_map, {})

    def test_prefetch_skips_unknown_fields(self):
        """Fields not in field_info are skipped."""
        backend = MockBackend()
        field_info = {"name": FieldInfo("name", "char")}
        rows = [{"name": "Test", "unknown_field": "some_ref"}]

        ref_map = prefetch_references(backend, "res.partner", field_info, rows)
        self.assertEqual(ref_map, {})

    def test_prefetch_deduplicates(self):
        """Same reference in multiple rows is only queried once."""
        backend = MockBackend()
        backend.create("res.country", {"name": "DE"})
        backend.create(
            "ir.model.data",
            {
                "module": "base",
                "name": "de",
                "model": "res.country",
                "res_id": 1,
            },
        )

        field_info = {
            "country_id": FieldInfo("country_id", "many2one", "res.country"),
        }
        rows = [
            {"country_id": "base.de"},
            {"country_id": "base.de"},
            {"country_id": "base.de"},
        ]

        ref_map = prefetch_references(backend, "res.partner", field_info, rows)
        self.assertEqual(len(ref_map), 1)


class TestResolveRow(unittest.TestCase):
    def test_resolve_many2one_external_id(self):
        """Resolve many2one field with external ID."""
        backend = MockBackend()
        backend.create("res.country", {"name": "DE"})

        field_info = {
            "name": FieldInfo("name", "char"),
            "country_id": FieldInfo("country_id", "many2one", "res.country"),
        }
        ref_map = {("res.country", "base", "de"): 1}

        resolved, warnings = resolve_row(
            backend,
            "res.partner",
            field_info,
            {"name": "Alice", "country_id": "base.de"},
            ref_map,
        )

        self.assertEqual(resolved["country_id"], 1)
        self.assertEqual(resolved["name"], "Alice")

    def test_resolve_many2many_pipe(self):
        """Resolve many2many with pipe-delimited IDs → [(6, 0, [ids])]."""
        backend = MockBackend()
        field_info = {
            "tag_ids": FieldInfo("tag_ids", "many2many", "res.tag"),
        }
        ref_map = {
            ("res.tag", "__import__", "a"): 10,
            ("res.tag", "__import__", "b"): 20,
        }

        resolved, _ = resolve_row(
            backend,
            "res.partner",
            field_info,
            {"tag_ids": "a|b"},
            ref_map,
        )

        self.assertEqual(resolved["tag_ids"], [(6, 0, [10, 20])])

    def test_resolve_passes_through_non_relational(self):
        """Non-relational fields pass through unchanged."""
        backend = MockBackend()
        field_info = {
            "name": FieldInfo("name", "char"),
            "active": FieldInfo("active", "boolean"),
        }

        resolved, _ = resolve_row(
            backend,
            "res.partner",
            field_info,
            {"name": "Test", "active": True},
            {},
        )

        self.assertEqual(resolved["name"], "Test")
        self.assertEqual(resolved["active"], True)

    def test_resolve_db_id_standard_model(self):
        """Integer value in many2one for standard model → allowed, no warning."""
        backend = MockBackend()
        backend.create("res.country", {"name": "DE"})

        field_info = {
            "country_id": FieldInfo("country_id", "many2one", "res.country"),
        }

        resolved, warnings = resolve_row(
            backend,
            "res.partner",
            field_info,
            {"country_id": 1},
            {},
        )

        self.assertEqual(resolved["country_id"], 1)
        # Standard models don't produce warnings
        self.assertEqual(len(warnings), 0)

    def test_resolve_db_id_non_standard_model_accepted_with_warning(self):
        """Integer value in many2one for non-standard model → accepted with warning."""
        backend = MockBackend()
        backend.create("res.partner", {"name": "Existing"})

        field_info = {
            "partner_id": FieldInfo("partner_id", "many2one", "res.partner"),
        }

        resolved, warnings = resolve_row(
            backend,
            "sale.order",
            field_info,
            {"partner_id": 1},
            {},
        )

        self.assertEqual(resolved["partner_id"], 1)
        self.assertTrue(len(warnings) > 0)
        self.assertIn("database ID", warnings[0])

    def test_resolve_db_id_nonexistent_raises(self):
        """Integer value pointing to nonexistent record → raises ValueError."""
        backend = MockBackend()
        field_info = {
            "country_id": FieldInfo("country_id", "many2one", "res.country"),
        }

        with self.assertRaises(ValueError) as ctx:
            resolve_row(
                backend,
                "res.partner",
                field_info,
                {"country_id": 999},
                {},
            )
        self.assertIn("not found", str(ctx.exception))

    def test_resolve_missing_external_id_raises(self):
        """External ID not in ref_map → raises ValueError."""
        backend = MockBackend()
        field_info = {
            "country_id": FieldInfo("country_id", "many2one", "res.country"),
        }

        with self.assertRaises(ValueError) as ctx:
            resolve_row(
                backend,
                "res.partner",
                field_info,
                {"country_id": "base.missing"},
                {},
            )
        self.assertIn("not found", str(ctx.exception))

    def test_resolve_passes_through_special_fields(self):
        """__external_id__ and __op__ pass through unchanged."""
        backend = MockBackend()
        field_info = {}

        resolved, _ = resolve_row(
            backend,
            "res.partner",
            field_info,
            {"__external_id__": "test", "__op__": "create"},
            {},
        )

        self.assertEqual(resolved["__external_id__"], "test")
        self.assertEqual(resolved["__op__"], "create")

    def test_resolve_empty_values_pass_through(self):
        """Empty/falsy values pass through unchanged."""
        backend = MockBackend()
        field_info = {
            "name": FieldInfo("name", "char"),
            "email": FieldInfo("email", "char"),
        }

        resolved, _ = resolve_row(
            backend,
            "res.partner",
            field_info,
            {"name": "", "email": None},
            {},
        )

        self.assertEqual(resolved["name"], "")
        self.assertIsNone(resolved["email"])

    def test_resolve_unknown_fields_pass_through(self):
        """Fields not in model schema pass through (Odoo will handle/ignore)."""
        backend = MockBackend()
        field_info = {"name": FieldInfo("name", "char")}

        resolved, _ = resolve_row(
            backend,
            "res.partner",
            field_info,
            {"name": "Test", "unknown_field": "value"},
            {},
        )

        self.assertEqual(resolved["unknown_field"], "value")

    def test_resolve_m2m_list_passes_through(self):
        """Many2many already as a list (command format) passes through."""
        backend = MockBackend()
        field_info = {
            "tag_ids": FieldInfo("tag_ids", "many2many", "res.tag"),
        }

        resolved, _ = resolve_row(
            backend,
            "res.partner",
            field_info,
            {"tag_ids": [(6, 0, [1, 2, 3])]},
            {},
        )

        self.assertEqual(resolved["tag_ids"], [(6, 0, [1, 2, 3])])


if __name__ == "__main__":
    unittest.main(verbosity=2)
