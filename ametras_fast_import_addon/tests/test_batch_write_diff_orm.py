"""Batched load() writes leave the database exactly as row-by-row writes.

Every case imports the same rows twice from the same database state: once
row by row (create/write per row) and once batched through load(). Between
the two runs the transaction goes back to a savepoint. Both runs must give
the same row results and the same stored data: field values, external IDs,
company-dependent values (ir.property) and chatter side effects (messages,
followers). Record ids are compared through the records' names, because the
second run gets new ids.

Runs in the release-gated test-odoo CI job (real Postgres + Odoo). Uses only
res.partner and models of base/mail, which the module depends on.

    odoo-bin -d <db> -i ametras_fast_import_addon --test-enable \\
        --test-tags /ametras_fast_import_addon:TestBatchWriteDiffOrm
"""
from odoo.tests import TransactionCase, tagged

from odoo.addons.ametras_fast_import_addon.models.import_engine import (
    ImportConfig,
    Importer,
    ParsedRow,
)
from odoo.addons.ametras_fast_import_addon.models.orm_backend import OrmBackend

PREFIX = "FIDIFF"

SCALAR_FIELDS = [
    "name",
    "ref",
    "function",
    "comment",
    "email",
    "phone",
    "website",
    "street",
    "zip",
    "city",
    "is_company",
    "type",
    "date",
    "color",
    "partner_latitude",
    "lang",
    "active",
    "barcode",
]
RELATIONAL_FIELDS = ["country_id", "title", "category_id", "parent_id"]

FULL_MAPPING = {
    "N": "name",
    "Ref": "ref",
    "Fn": "function",
    "Notes": "comment",
    "Mail": "email",
    "Phone": "phone",
    "Web": "website",
    "Street": "street",
    "Zip": "zip",
    "City": "city",
    "Co": "is_company",
    "Type": "type",
    "Date": "date",
    "Color": "color",
    "Lat": "partner_latitude",
    "Lang": "lang",
    "Active": "active",
    "Barcode": "barcode",
    "Country": "country_id",
    "Title": "title",
    "Cats": "category_id",
    "Parent": "parent_id",
}


@tagged("post_install", "-at_install")
class TestBatchWriteDiffOrm(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Partner = cls.env["res.partner"].with_context(active_test=False)
        cls.title = cls.env["res.partner.title"].create({"name": f"{PREFIX} Title"})
        cls.cat1 = cls.env["res.partner.category"].create({"name": f"{PREFIX} Cat 1"})
        cls.cat2 = cls.env["res.partner.category"].create({"name": f"{PREFIX} Cat 2"})
        cls.existing = cls.Partner.create(
            [
                {
                    "name": f"{PREFIX} Existing {i}",
                    "ref": f"{PREFIX}-E{i}",
                    "street": "Old street",
                    "city": "Old city",
                    "email": f"old{i}@example.com",
                    "category_id": [(6, 0, [cls.cat1.id])],
                }
                for i in range(1, 4)
            ]
        )
        cls.env["ir.model.data"].create(
            {
                "module": "__import__",
                "name": "fidiff_existing_1",
                "model": "res.partner",
                "res_id": cls.existing[0].id,
            }
        )

    # -- helpers --------------------------------------------------------------

    def _import(self, rows, batch_write, mapping, **config):
        importer = Importer(
            OrmBackend(self.env),
            ImportConfig(
                model="res.partner",
                field_mappings=mapping,
                batch_write=batch_write,
                batch_size=len(rows),
                **config,
            ),
        )
        parsed = [ParsedRow(index=i + 1, data=row) for i, row in enumerate(rows)]
        return importer.import_rows(parsed)

    def _snapshot(self, results):
        self.env.flush_all()
        self.env.invalidate_all()
        partners = self.Partner.search([("name", "=like", f"{PREFIX}%")])
        name_of = {p.id: p.name for p in partners}

        def rel(value):
            if not value:
                return False
            return sorted(r.display_name for r in value)

        records = {}
        for partner in partners:
            vals = partner.read(SCALAR_FIELDS)[0]
            vals.pop("id")
            for field in RELATIONAL_FIELDS:
                vals[field] = rel(partner[field])
            records[partner.name] = vals
        self.env.cr.execute(
            """
            SELECT d.module, d.name, d.noupdate, p.name
              FROM ir_model_data d JOIN res_partner p ON p.id = d.res_id
             WHERE d.model = 'res.partner' AND p.name LIKE %s
            """,
            (f"{PREFIX}%",),
        )
        xmlids = sorted(self.env.cr.fetchall())
        self.env.cr.execute(
            """
            SELECT p.name, ip.company_id, ip.value_text
              FROM ir_property ip
              JOIN res_partner p ON 'res.partner,' || p.id = ip.res_id
             WHERE ip.name = 'barcode' AND p.name LIKE %s
            """,
            (f"{PREFIX}%",),
        )
        properties = sorted(self.env.cr.fetchall())
        ids = list(name_of)
        messages = self.env["mail.message"].search_count(
            [("model", "=", "res.partner"), ("res_id", "in", ids)]
        )
        followers = self.env["mail.followers"].search_count(
            [("res_model", "=", "res.partner"), ("res_id", "in", ids)]
        )
        row_view = [
            (
                r.row_index,
                r.ok,
                r.action,
                r.strategy,
                r.error,
                name_of.get(r.record_id),
            )
            for r in results
        ]
        return {
            "rows": row_view,
            "records": records,
            "xmlids": xmlids,
            "properties": properties,
            "messages": messages,
            "followers": followers,
        }

    def _assert_same(self, rows, mapping=None, **config):
        mapping = mapping or FULL_MAPPING
        snapshots = {}
        # Both runs must start from the same stored state: write what the test
        # set up before the savepoint, or the first run would flush it inside
        # the savepoint and the rollback would take it away from the second.
        self.env.flush_all()
        for batch_write in (False, True):
            self.env.cr.execute("SAVEPOINT fidiff")
            results = self._import(rows, batch_write, mapping, **config)
            snapshots[batch_write] = self._snapshot(results)
            self.env.cr.execute("ROLLBACK TO SAVEPOINT fidiff")
            self.env.invalidate_all()
            self.env.registry.reset_changes()
        row_by_row, batched = snapshots[False], snapshots[True]
        for part in (
            "rows",
            "records",
            "xmlids",
            "properties",
            "messages",
            "followers",
        ):
            self.assertEqual(
                batched[part],
                row_by_row[part],
                msg=f"Batched load() and row-by-row import differ in {part!r}",
            )
        return row_by_row

    # -- cases ----------------------------------------------------------------

    def test_create_every_field_type(self):
        snap = self._assert_same(
            [
                {
                    "N": f"{PREFIX} Full",
                    "Ref": f"{PREFIX}-F1",
                    "Fn": "Buyer",
                    "Notes": "<p>Note with <b>markup</b></p>",
                    "Mail": "full@example.com",
                    "Phone": "+49 30 123",
                    "Web": "https://example.com",
                    "Street": "Hauptstr. 1",
                    "Zip": "10115",
                    "City": "Berlin",
                    "Co": "yes",
                    "Type": "contact",
                    "Date": "2026-03-01",
                    "Color": "3",
                    "Lat": "52.520008",
                    "Lang": "en_US",
                    "Active": "1",
                    "Barcode": "4006381333931",
                    "Country": "base.de",
                    "Title": f"{PREFIX} Title",
                    "Cats": f"{PREFIX} Cat 1|{PREFIX} Cat 2",
                },
                {
                    "N": f"{PREFIX} Labels",
                    "Co": "0",
                    "Type": "Invoice Address",
                    "Country": "Germany",
                    "Active": "false",
                    "Lat": "-0.5",
                },
                {
                    "N": f"{PREFIX} Empty cells",
                    "Fn": "",
                    "Date": "",
                    "Co": "",
                    "Cats": "",
                },
            ]
        )
        self.assertTrue(
            all(row[1] for row in snap["rows"]), msg=f"rows: {snap['rows']}"
        )

    def test_update_by_search_key_keeps_unset_fields(self):
        self._assert_same(
            [
                {"Ref": f"{PREFIX}-E1", "Street": "New street 1"},
                {"Ref": f"{PREFIX}-E2", "City": "New city 2", "Barcode": "111"},
                {"Ref": f"{PREFIX}-E3", "Street": "", "Cats": f"{PREFIX} Cat 2"},
            ],
            search_keys=["ref"],
        )

    def test_external_ids_create_then_update(self):
        self._assert_same(
            [
                {"Id": "fidiff_new_1", "N": f"{PREFIX} X1", "City": "A"},
                {"Id": "fidiff_existing_1", "N": f"{PREFIX} Existing 1", "City": "B"},
                {"Id": "__import__.fidiff_new_1", "N": f"{PREFIX} X1", "City": "C"},
                {"Id": "other_module.fidiff_new_2", "N": f"{PREFIX} X2"},
            ],
            mapping={"Id": "id", "N": "name", "City": "city"},
            use_external_id=True,
        )

    def test_failing_rows_report_the_same_errors(self):
        snap = self._assert_same(
            [
                {"N": f"{PREFIX} Ok 1", "City": "A"},
                {"N": f"{PREFIX} Bad date", "Date": "31.12.2026"},
                {"N": f"{PREFIX} Bad country", "Country": "Nowhere Land"},
                {"N": f"{PREFIX} Bad type", "Type": "no such type"},
                {"N": f"{PREFIX} Ok 2", "City": "B"},
            ]
        )
        self.assertEqual(
            [row[1] for row in snap["rows"]],
            [True, False, False, False, True],
            msg=f"rows: {snap['rows']}",
        )

    def test_contact_names_company_created_above(self):
        self._assert_same(
            [
                {"N": f"{PREFIX} Company", "Co": "1"},
                {"N": f"{PREFIX} Somebody else"},
                {"N": f"{PREFIX} Contact", "Parent": f"{PREFIX} Company"},
            ]
        )

    def test_update_by_integer_and_date_search_keys(self):
        """Search keys on number and date fields: the cell text must find the
        record exactly as the server's "=" does (no duplicate is created), also
        for text the server reads as the same value ("07", "2026-3-1")."""
        self.existing[0].write({"color": 7, "date": "2026-03-01"})
        for cells, key in (
            ({"Color": "7", "City": "By color"}, "color"),
            ({"Color": "07", "City": "By 07"}, "color"),
            ({"Date": "2026-03-01", "City": "By date"}, "date"),
            ({"Date": "2026-3-1", "City": "By 3-1"}, "date"),
        ):
            # with a name, a missed lookup would create a second partner
            row = dict(cells, N=f"{PREFIX} Existing 1")
            mapping = {"N": "name", "Color": "color", "Date": "date", "City": "city"}
            snap = self._assert_same([row], mapping=mapping, search_keys=[key])
            self.assertEqual(
                [(r[1], r[2]) for r in snap["rows"]],
                [(True, "updated")],
                msg=f"The {key} cell must find the existing partner: {snap['rows']}",
            )

    def test_rows_reaching_one_record_through_different_identifiers(self):
        self._assert_same(
            [
                {
                    "Id": "fidiff_mixed",
                    "N": f"{PREFIX} Mixed",
                    "Ref": f"{PREFIX}-M1",
                    "City": "A",
                },
                {"N": f"{PREFIX} Mixed", "Ref": f"{PREFIX}-M1", "City": "B"},
                {
                    "Id": "fidiff_mixed_other",
                    "N": f"{PREFIX} Mixed 2",
                    "Ref": f"{PREFIX}-M1",
                    "City": "C",
                },
            ],
            mapping={"Id": "id", "N": "name", "Ref": "ref", "City": "city"},
            use_external_id=True,
            search_keys=["ref"],
        )

    def test_update_group_with_one_bad_cell(self):
        """One bad cell in a group of updates: the other rows must be stored,
        exactly as row by row (load() rolls back, the halves are sent again)."""
        snap = self._assert_same(
            [
                {"Ref": f"{PREFIX}-E1", "City": "New 1", "Date": "2026-01-01"},
                {"Ref": f"{PREFIX}-E2", "City": "New 2", "Date": "2026-13-45"},
                {"Ref": f"{PREFIX}-E3", "City": "New 3", "Date": "2026-01-03"},
            ],
            mapping={"Ref": "ref", "City": "city", "Date": "date"},
            search_keys=["ref"],
        )
        self.assertEqual(
            snap["records"][f"{PREFIX} Existing 1"]["city"],
            "New 1",
            msg="A good row next to a bad one must be stored",
        )

    def test_database_id_updates(self):
        rows = [
            {"Db": str(self.existing[1].id), "City": "By id"},
            {"Db": "999999999", "City": "Missing"},
        ]
        self._assert_same(rows, mapping={"Db": ".id", "City": "city"})
