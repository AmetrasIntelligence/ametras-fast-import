"""Real-ORM type-coercion tests for the import engine.

The other engine tests use an in-memory MockBackend, whose create/write just
stores the raw dict — so they can prove what resolve_row *outputs*, but never
what Odoo actually *stores*. Yet the original bug lived exactly there: Odoo's
Boolean.convert_to_column does bool("0") -> True. These tests drive the real
ORM (OrmBackend) so every field type is validated at the layer where the value
is really converted, on a real transaction.

Runs in the release-gated `test-odoo` CI job (real Postgres + Odoo). Uses only
BASE res.partner fields so it needs no vertical addons. (No datetime field
exists on base res.partner; datetime passthrough is covered by the unit tests
and was validated end-to-end against a live Odoo.)

    odoo-bin -d <db> -i ametras_fast_import_addon --test-enable \\
        --test-tags /ametras_fast_import_addon
"""
from odoo.tests import TransactionCase, tagged

from odoo.addons.ametras_fast_import_addon.models.import_engine import (
    ImportConfig,
    Importer,
    ParsedRow,
)
from odoo.addons.ametras_fast_import_addon.models.orm_backend import OrmBackend


@tagged("post_install", "-at_install")
class TestImportTypesOrm(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Partner = cls.env["res.partner"]
        cls.germany = cls.env.ref("base.de")
        cls.title = cls.env["res.partner.title"].create({"name": "FI Test Title"})
        cls.cat1 = cls.env["res.partner.category"].create({"name": "FI Cat 1"})
        cls.cat2 = cls.env["res.partner.category"].create({"name": "FI Cat 2"})

    def _run(self, mappings, rows, model="res.partner"):
        """Import dict rows through the real ORM; return per-row RowResults."""
        imp = Importer(
            OrmBackend(self.env), ImportConfig(model=model, field_mappings=mappings)
        )
        parsed = [ParsedRow(index=i + 1, data=r) for i, r in enumerate(rows)]
        return imp.import_rows(parsed)

    # -- boolean: the actual bug ---------------------------------------------

    def test_boolean_zero_is_stored_false(self):
        """CSV "0" on a boolean must be stored False (was True: bool("0"))."""
        res = self._run({"N": "name", "B": "is_company"}, [{"N": "FI b0", "B": "0"}])
        self.assertTrue(res[0].ok, res[0].error)
        self.assertIs(self.Partner.browse(res[0].record_id).is_company, False)

    def test_boolean_variants(self):
        cases = {
            "1": True,
            "true": True,
            "YES": True,
            "0": False,
            "false": False,
            "no": False,
            "": False,
        }
        for raw, exp in cases.items():
            res = self._run(
                {"N": "name", "B": "is_company"}, [{"N": f"FI bv {raw!r}", "B": raw}]
            )
            self.assertTrue(res[0].ok, f"{raw!r}: {res[0].error}")
            self.assertIs(
                self.Partner.browse(res[0].record_id).is_company, exp, f"{raw!r}"
            )

    # -- full type matrix, verified from the DB ------------------------------

    def test_all_field_types_stored_correctly(self):
        mapping = {
            "N": "name",
            "Fn": "function",
            "Notes": "comment",
            "Color": "color",
            "Lat": "partner_latitude",
            "Dt": "date",
            "Sel": "type",
            "CountryX": "country_id/id",
            "TitleDb": "title/.id",
            "Cats": "category_id",
            "B": "is_company",
        }
        row = {
            "N": "FI full",
            "Fn": "Tester",
            "Notes": "hello note",
            "Color": "3",
            "Lat": "50.94",
            "Dt": "1990-05-17",
            "Sel": "invoice",
            "CountryX": "base.de",
            "TitleDb": str(self.title.id),
            "Cats": f"{self.cat1.id}|{self.cat2.id}",
            "B": "0",
        }
        res = self._run(mapping, [row])
        self.assertTrue(res[0].ok, res[0].error)
        p = self.Partner.browse(res[0].record_id)
        self.assertEqual(p.function, "Tester")  # char
        self.assertIn("hello note", p.comment or "")  # html
        self.assertEqual(p.color, 3)  # integer
        self.assertAlmostEqual(p.partner_latitude, 50.94)  # float
        self.assertEqual(str(p.date), "1990-05-17")  # date
        self.assertEqual(p.type, "invoice")  # selection
        self.assertEqual(p.country_id, self.germany)  # m2o external id
        self.assertEqual(p.title, self.title)  # m2o /.id
        self.assertEqual(set(p.category_id.ids), {self.cat1.id, self.cat2.id})  # m2m
        self.assertIs(p.is_company, False)  # boolean

    # -- bad values must fail the row LOUDLY, never corrupt ------------------

    def test_bad_float_fails_row_creates_nothing(self):
        before = self.Partner.search_count([])
        res = self._run(
            {"N": "name", "Lat": "partner_latitude"},
            [{"N": "FI badfloat", "Lat": "50,94"}],
        )
        self.assertFalse(res[0].ok)
        self.assertIsNone(res[0].record_id)
        self.assertEqual(self.Partner.search_count([]), before)

    def test_bad_selection_fails_row(self):
        res = self._run(
            {"N": "name", "Sel": "type"}, [{"N": "FI badsel", "Sel": "bogus"}]
        )
        self.assertFalse(res[0].ok)

    # -- #6: non-numeric .id fails the row (was silently dropped -> dup) ------

    def test_bad_dbid_isolated_no_duplicate(self):
        existing = self.Partner.create({"name": "FI existing"})
        res = self._run(
            {"Id": ".id", "N": "name"},
            [
                {"Id": str(existing.id), "N": "FI upd ok"},  # valid update
                {"Id": "abc", "N": "FI broken"},  # bad .id -> fail
            ],
        )
        by = {r.row_index: r for r in res}
        self.assertTrue(by[1].ok, by[1].error)
        self.assertFalse(by[2].ok)
        self.assertIn("database id", (by[2].error or "").lower())
        self.assertEqual(self.Partner.browse(existing.id).name, "FI upd ok")  # updated
        self.assertFalse(
            self.Partner.search_count([("name", "=", "FI broken")])
        )  # no dup

    def test_multivalue_m2m_via_slash_dotid_raises(self):
        """A delimited value on `<field>/.id` is not a single int -> errors.

        Multi-value m2m by db id must use the BARE field mapping instead.
        """
        res = self._run(
            {"N": "name", "Cats": "category_id/.id"},
            [{"N": "FI mm bad", "Cats": f"{self.cat1.id}|{self.cat2.id}"}],
        )
        self.assertFalse(res[0].ok)
        self.assertIn("database id", (res[0].error or "").lower())

    def test_multivalue_m2m_bare_field_works(self):
        res = self._run(
            {"N": "name", "Cats": "category_id"},
            [{"N": "FI mm ok", "Cats": f"{self.cat1.id}|{self.cat2.id}"}],
        )
        self.assertTrue(res[0].ok, res[0].error)
        self.assertEqual(
            set(self.Partner.browse(res[0].record_id).category_id.ids),
            {self.cat1.id, self.cat2.id},
        )

    # -- relation & selection resolution by display name / label -------------

    def test_m2o_resolved_by_display_name(self):
        """A many2one referenced by display name resolves via name_search."""
        res = self._run(
            {"N": "name", "C": "country_id/id"}, [{"N": "FI byname", "C": "Germany"}]
        )
        self.assertTrue(res[0].ok, res[0].error)
        self.assertEqual(self.Partner.browse(res[0].record_id).country_id, self.germany)

    def test_m2o_bad_name_fails_loud(self):
        res = self._run(
            {"N": "name", "C": "country_id/id"}, [{"N": "FI badname", "C": "Atlantis"}]
        )
        self.assertFalse(res[0].ok)
        self.assertIn("not found", (res[0].error or "").lower())

    def test_m2m_resolved_by_display_name(self):
        res = self._run(
            {"N": "name", "Cats": "category_id"},
            [{"N": "FI mm name", "Cats": "FI Cat 1|FI Cat 2"}],
        )
        self.assertTrue(res[0].ok, res[0].error)
        self.assertEqual(
            set(self.Partner.browse(res[0].record_id).category_id.ids),
            {self.cat1.id, self.cat2.id},
        )

    def test_selection_resolved_by_label(self):
        """A selection referenced by its label resolves to the stored key."""
        res = self._run(
            {"N": "name", "Sel": "type"}, [{"N": "FI label", "Sel": "Invoice Address"}]
        )
        self.assertTrue(res[0].ok, res[0].error)
        self.assertEqual(self.Partner.browse(res[0].record_id).type, "invoice")

    # -- update path: coercion on write + empty semantics --------------------

    def test_update_by_dbid_coerces_bool_and_preserves_empty(self):
        p = self.Partner.create(
            {"name": "FI up", "is_company": True, "function": "keep"}
        )
        res = self._run(
            {"Id": ".id", "B": "is_company", "Fn": "function"},
            [{"Id": str(p.id), "B": "0", "Fn": ""}],  # "0"->False; empty char dropped
        )
        self.assertTrue(res[0].ok, res[0].error)
        self.assertEqual(res[0].record_id, p.id)  # UPDATE, not create
        p2 = self.Partner.browse(p.id)
        self.assertIs(p2.is_company, False)  # coerced on write
        self.assertEqual(p2.function, "keep")  # empty non-bool not clobbered

    def test_update_empty_boolean_sets_false(self):
        p = self.Partner.create({"name": "FI upe", "is_company": True})
        res = self._run({"Id": ".id", "B": "is_company"}, [{"Id": str(p.id), "B": ""}])
        self.assertTrue(res[0].ok, res[0].error)
        self.assertIs(self.Partner.browse(p.id).is_company, False)
