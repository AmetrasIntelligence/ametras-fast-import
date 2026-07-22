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
from import_engine.transformer import transform_row_data

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

    def name_search(self, model, value):
        self._ensure_model(model)
        return [
            (rid, vals.get("name"))
            for rid, vals in self.records[model].items()
            if vals.get("name") == value
        ]

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

    def test_resolve_empty_non_boolean_values_dropped(self):
        """Empty non-boolean cells are dropped (not written).

        The transformer now forwards empty regular-field values so resolve_row
        can decide per type. For everything except booleans an empty cell must
        be omitted from the write, so a partial-column update never clobbers the
        existing DB value and a create falls back to the field default.
        """
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

        self.assertNotIn("name", resolved)
        self.assertNotIn("email", resolved)

    def test_resolve_empty_unknown_field_dropped(self):
        """An empty cell for a field not in the model schema is dropped."""
        backend = MockBackend()
        field_info = {"name": FieldInfo("name", "char")}

        resolved, _ = resolve_row(
            backend,
            "res.partner",
            field_info,
            {"name": "Test", "mystery": ""},
            {},
        )

        self.assertEqual(resolved["name"], "Test")
        self.assertNotIn("mystery", resolved)

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

    # -- Regression: APX-3827 -------------------------------------------------
    # A many2many value that is a bare database ID (numeric string or int) was
    # passed through raw, so Odoo rejected it with
    #   ValueError: Wrong value for product.template.route_ids: 6
    # It must be wrapped in a (6, 0, [ids]) command like the external-id path.

    def test_resolve_m2m_numeric_string_db_id(self):
        """A single numeric string DB id is wrapped as a replace command."""
        backend = MockBackend()
        field_info = {
            "route_ids": FieldInfo("route_ids", "many2many", "stock.location.route"),
        }

        resolved, warnings = resolve_row(
            backend,
            "product.template",
            field_info,
            {"route_ids": "6"},  # the exact value from the client's row 400
            {},
        )

        self.assertEqual(resolved["route_ids"], [(6, 0, [6])])
        # Non-standard model → nudge toward external IDs.
        self.assertTrue(any("database ID" in w for w in warnings))

    def test_resolve_m2m_int_db_id(self):
        """A single integer DB id (e.g. from /.id) is wrapped."""
        backend = MockBackend()
        field_info = {
            "route_ids": FieldInfo("route_ids", "many2many", "stock.location.route"),
        }

        resolved, _ = resolve_row(
            backend,
            "product.template",
            field_info,
            {"route_ids": 6},
            {},
        )

        self.assertEqual(resolved["route_ids"], [(6, 0, [6])])

    def test_resolve_m2m_delimited_numeric_db_ids(self):
        """Pipe- and comma-delimited numeric DB ids wrap into one command.

        A delimited numeric string like "6|7" is not .isdigit(), so it must be
        recognised as DB ids *before* the external-id branch tries to look it
        up (which would fail as "not found").
        """
        backend = MockBackend()
        field_info = {
            "route_ids": FieldInfo("route_ids", "many2many", "stock.location.route"),
        }

        for raw, expected in (("6|7", [6, 7]), ("6, 8 ,9", [6, 8, 9])):
            resolved, _ = resolve_row(
                backend,
                "product.template",
                field_info,
                {"route_ids": raw},
                {},
            )
            self.assertEqual(resolved["route_ids"], [(6, 0, expected)])

    # -- Regression: boolean CSV coercion -------------------------------------
    # Hybrid supplier-infos imported via the fast importer got
    # update_price_via_interface = True even though the CSV carried "0" for
    # every row, because the raw string was written straight to create/write
    # and Odoo's Boolean.convert_to_column does bool("0") -> True. resolve_row
    # must coerce boolean strings the way Odoo's import layer would.

    def test_resolve_boolean_string_zero_is_false(self):
        """The exact ticket case: CSV string "0" on a boolean field -> False.

        Feeds the *string* "0" (as it arrives from the CSV), NOT a pre-typed
        Python bool — that distinction is the whole bug.
        """
        backend = MockBackend()
        field_info = {
            "update_price_via_interface": FieldInfo(
                "update_price_via_interface", "boolean"
            ),
        }

        resolved, _ = resolve_row(
            backend,
            "product.supplierinfo",
            field_info,
            {"update_price_via_interface": "0"},
            {},
        )

        self.assertIs(resolved["update_price_via_interface"], False)

    def test_resolve_boolean_string_one_is_true(self):
        backend = MockBackend()
        field_info = {"flag": FieldInfo("flag", "boolean")}

        resolved, _ = resolve_row(backend, "res.partner", field_info, {"flag": "1"}, {})
        self.assertIs(resolved["flag"], True)

    def test_resolve_boolean_word_variants(self):
        backend = MockBackend()
        field_info = {"flag": FieldInfo("flag", "boolean")}

        cases = {
            "true": True,
            "True": True,
            "YES": True,
            "false": False,
            "False": False,
            "no": False,
            "NO": False,
        }
        for raw, expected in cases.items():
            resolved, _ = resolve_row(
                backend, "res.partner", field_info, {"flag": raw}, {}
            )
            self.assertIs(resolved["flag"], expected, raw)

    def test_resolve_boolean_already_bool_passthrough(self):
        """A pre-typed Python bool (legacy path) is preserved."""
        backend = MockBackend()
        field_info = {"flag": FieldInfo("flag", "boolean")}

        for value in (True, False):
            resolved, _ = resolve_row(
                backend, "res.partner", field_info, {"flag": value}, {}
            )
            self.assertIs(resolved["flag"], value)

    def test_resolve_boolean_empty_cell_is_false(self):
        """An empty boolean cell becomes False (mirrors ir_fields "" -> False).

        This is how a hybrid SI's flag can be cleared on update: the transformer
        now forwards the empty cell, and resolve_row turns it into False for a
        boolean field (rather than dropping it and leaving the old value).
        """
        backend = MockBackend()
        field_info = {"flag": FieldInfo("flag", "boolean")}

        for empty in ("", None):
            resolved, _ = resolve_row(
                backend, "res.partner", field_info, {"flag": empty}, {}
            )
            self.assertIn("flag", resolved)
            self.assertIs(resolved["flag"], False)

    def test_resolve_boolean_garbage_raises(self):
        """An unrecognised boolean token raises (per-row error, no guessing)."""
        backend = MockBackend()
        field_info = {"flag": FieldInfo("flag", "boolean")}

        with self.assertRaises(ValueError):
            resolve_row(backend, "res.partner", field_info, {"flag": "maybe"}, {})


class TestNonBooleanScalarPassthrough(unittest.TestCase):
    """Non-boolean scalars are passed through resolve_row UNCHANGED.

    Deliberately NOT coerced client-side: Odoo's field.convert_to_column does
    int()/float()/date-parse/selection-validation server-side on create/write
    (for BOTH the ORM and XML-RPC backends), producing the correct typed value
    or a loud per-row error. Re-implementing that here would be redundant and
    risky (e.g. diverging from Float's rounding, or rejecting a date format Odoo
    accepts). These tests pin that contract: the resolver must not mangle them.

    Boolean is the sole exception (bool("0") is silently True) and is coerced;
    see TestResolveRow.test_resolve_boolean_* and TestBooleanImportPipeline.
    """

    def _resolve_one(self, ftype, value, comodel=""):
        backend = MockBackend()
        info = FieldInfo("f", ftype, comodel)
        resolved, warnings = resolve_row(
            backend, "some.model", {"f": info}, {"f": value}, {}
        )
        return resolved, warnings

    def test_integer_string_unchanged(self):
        resolved, _ = self._resolve_one("integer", "42")
        self.assertEqual(resolved["f"], "42")  # Odoo does int("42") on write

    def test_float_iso_unchanged(self):
        resolved, _ = self._resolve_one("float", "95.70")
        self.assertEqual(resolved["f"], "95.70")

    def test_float_european_not_mangled(self):
        # We must NOT guess "95,70" -> 95.70. Odoo rejects it loudly per row;
        # silently reinterpreting it could corrupt the value.
        resolved, _ = self._resolve_one("monetary", "95,70")
        self.assertEqual(resolved["f"], "95,70")

    def test_date_iso_unchanged(self):
        resolved, _ = self._resolve_one("date", "2026-07-22")
        self.assertEqual(resolved["f"], "2026-07-22")

    def test_datetime_unchanged(self):
        resolved, _ = self._resolve_one("datetime", "2026-07-22 08:30:00")
        self.assertEqual(resolved["f"], "2026-07-22 08:30:00")

    def test_selection_key_unchanged(self):
        # A selection value passes through; Odoo validates it against the keys
        # and raises "Wrong value" for an unknown label — a loud per-row error.
        resolved, _ = self._resolve_one("selection", "draft")
        self.assertEqual(resolved["f"], "draft")

    def test_char_and_text_unchanged(self):
        for ftype in ("char", "text", "html"):
            resolved, _ = self._resolve_one(ftype, "  keep spaces  ")
            self.assertEqual(resolved["f"], "  keep spaces  ", ftype)

    def test_integer_string_produces_no_warning(self):
        _, warnings = self._resolve_one("integer", "42")
        self.assertEqual(warnings, [])


class TestRelationByName(unittest.TestCase):
    """Resolve relations by display name when there is no external id.

    Mirrors Odoo's model.load (db_id_for name_search fallback). The xml_id path
    still wins when present; name lookup only fills the gap.
    """

    def _country(self, backend, name):
        rid = backend.create("res.country", {"name": name})
        return rid

    def test_m2o_resolved_by_name(self):
        backend = MockBackend()
        de = self._country(backend, "Germany")
        field_info = {"country_id": FieldInfo("country_id", "many2one", "res.country")}
        resolved, _ = resolve_row(
            backend, "res.partner", field_info, {"country_id": "Germany"}, {}
        )
        self.assertEqual(resolved["country_id"], de)

    def test_m2o_external_id_preferred_over_name(self):
        backend = MockBackend()
        self._country(backend, "Germany")  # a same-named record exists
        field_info = {"country_id": FieldInfo("country_id", "many2one", "res.country")}
        ref_map = {("res.country", "base", "de"): 999}
        resolved, _ = resolve_row(
            backend, "res.partner", field_info, {"country_id": "base.de"}, ref_map
        )
        self.assertEqual(resolved["country_id"], 999)  # xml_id, not name_search

    def test_m2o_name_not_found_raises(self):
        backend = MockBackend()
        field_info = {"country_id": FieldInfo("country_id", "many2one", "res.country")}
        with self.assertRaises(ValueError) as ctx:
            resolve_row(
                backend, "res.partner", field_info, {"country_id": "Atlantis"}, {}
            )
        self.assertIn("not found", str(ctx.exception))

    def test_m2o_ambiguous_name_raises(self):
        backend = MockBackend()
        self._country(backend, "Dup")
        self._country(backend, "Dup")
        field_info = {"country_id": FieldInfo("country_id", "many2one", "res.country")}
        with self.assertRaises(ValueError) as ctx:
            resolve_row(backend, "res.partner", field_info, {"country_id": "Dup"}, {})
        self.assertIn("ambiguous", str(ctx.exception))

    def test_m2m_resolved_by_name(self):
        backend = MockBackend()
        a = backend.create("res.partner.category", {"name": "BMW"})
        b = backend.create("res.partner.category", {"name": "A_Prime"})
        field_info = {
            "category_id": FieldInfo("category_id", "many2many", "res.partner.category")
        }
        resolved, _ = resolve_row(
            backend, "res.partner", field_info, {"category_id": "BMW|A_Prime"}, {}
        )
        self.assertEqual(resolved["category_id"], [(6, 0, [a, b])])

    def test_name_lookup_cached_within_batch(self):
        """A ref_map reused across rows caches the name resolution."""
        backend = MockBackend()
        de = self._country(backend, "Germany")
        field_info = {"country_id": FieldInfo("country_id", "many2one", "res.country")}
        ref_map = {}
        for _ in range(3):
            resolved, _w = resolve_row(
                backend, "res.partner", field_info, {"country_id": "Germany"}, ref_map
            )
            self.assertEqual(resolved["country_id"], de)
        # the cache sentinel now holds the resolved name
        self.assertTrue(any(k == "__name_cache__" for k in ref_map))


class TestSelectionLabelResolution(unittest.TestCase):
    def test_label_mapped_to_key_in_resolve_row(self):
        backend = MockBackend()
        field_info = {
            "state": FieldInfo(
                "state", "selection", selection=[("draft", "Draft"), ("done", "Done")]
            )
        }
        resolved, _ = resolve_row(
            backend, "some.model", field_info, {"state": "Done"}, {}
        )
        self.assertEqual(resolved["state"], "done")

    def test_key_unchanged_in_resolve_row(self):
        backend = MockBackend()
        field_info = {
            "state": FieldInfo("state", "selection", selection=[("draft", "Draft")])
        }
        resolved, _ = resolve_row(
            backend, "some.model", field_info, {"state": "draft"}, {}
        )
        self.assertEqual(resolved["state"], "draft")


class TestBooleanImportPipeline(unittest.TestCase):
    """End-to-end (transform_row_data -> resolve_row) coverage for booleans.

    Exercises the real fast-import chain a raw CSV row travels through, proving
    the fix holds across BOTH steps rather than just inside resolve_row.
    """

    def _run(self, csv_row, field_mappings, field_info):
        mapped = transform_row_data(csv_row, field_mappings)
        resolved, warnings = resolve_row(
            MockBackend(), "product.supplierinfo", field_info, mapped, {}
        )
        return resolved

    def test_hybrid_si_flag_zero_stays_false(self):
        """The reported scenario: CSV 'update_price_via_interface' = 0.

        QlikView exports "0" for all 530,943 rows; the DB must NOT end up with
        the flag True. Runs the full CSV-column -> Odoo-field -> resolved-value
        chain the importer uses.
        """
        field_info = {
            "update_price_via_interface": FieldInfo(
                "update_price_via_interface", "boolean"
            ),
            "price": FieldInfo("price", "float"),
        }
        resolved = self._run(
            {"UpdatePrice": "0", "Price": "95.70"},
            {"UpdatePrice": "update_price_via_interface", "Price": "price"},
            field_info,
        )
        self.assertIs(resolved["update_price_via_interface"], False)

    def test_hybrid_si_flag_empty_cell_stays_false(self):
        """An empty flag cell also resolves to False (cannot silently become True)."""
        field_info = {
            "update_price_via_interface": FieldInfo(
                "update_price_via_interface", "boolean"
            ),
        }
        resolved = self._run(
            {"UpdatePrice": ""},
            {"UpdatePrice": "update_price_via_interface"},
            field_info,
        )
        self.assertIs(resolved["update_price_via_interface"], False)

    def test_flag_one_becomes_true(self):
        field_info = {"flag": FieldInfo("flag", "boolean")}
        resolved = self._run({"F": "1"}, {"F": "flag"}, field_info)
        self.assertIs(resolved["flag"], True)

    def test_empty_char_cell_not_written(self):
        """An empty non-boolean cell is dropped end-to-end (no clobber on update)."""
        field_info = {
            "name": FieldInfo("name", "char"),
            "flag": FieldInfo("flag", "boolean"),
        }
        resolved = self._run(
            {"N": "", "F": "0"}, {"N": "name", "F": "flag"}, field_info
        )
        self.assertNotIn("name", resolved)
        self.assertIs(resolved["flag"], False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
