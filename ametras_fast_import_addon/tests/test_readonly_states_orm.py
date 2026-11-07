"""Real-ORM test: readonly fields that a state makes writable are set on create.

Base has no model with such a field (stock.picking needs `stock`), so the test
gives res.partner.ref the declaration stock.picking uses for its operation type:
readonly=True, writable in draft.

    odoo-bin -d <db> -i ametras_fast_import_addon --test-enable \\
        --test-tags /ametras_fast_import_addon
"""
from unittest.mock import patch

from odoo.tests import TransactionCase, tagged

from odoo.addons.ametras_fast_import_addon.models.import_engine import (
    ImportConfig,
    Importer,
    ParsedRow,
)
from odoo.addons.ametras_fast_import_addon.models.orm_backend import OrmBackend

DRAFT_WRITABLE = {"draft": [("readonly", False)]}


@tagged("post_install", "-at_install")
class RecordingOrmBackend(OrmBackend):
    """OrmBackend that keeps the values handed to create() for a new record,
    row by row (create) or batched (create_many)."""

    def __init__(self, env):
        super().__init__(env)
        self.created_vals = []

    def create(self, model, vals):
        self.created_vals.append(dict(vals))
        return super().create(model, vals)

    def create_many(self, model, vals_list):
        self.created_vals.extend(dict(vals) for vals in vals_list)
        return super().create_many(model, vals_list)


class TestReadonlyStatesOrm(TransactionCase):
    def _create_partner(self, ref, batch_write):
        backend = RecordingOrmBackend(self.env)
        importer = Importer(
            backend,
            ImportConfig(
                model="res.partner",
                field_mappings={"N": "name", "R": "ref"},
                batch_write=batch_write,
            ),
        )
        results = importer.import_rows(
            [ParsedRow(index=1, data={"N": "FI readonly states", "R": ref})]
        )
        self.assertTrue(results[0].ok, results[0].error)
        partner = self.env["res.partner"].browse(results[0].record_id)
        return partner, backend.created_vals[0]

    def test_field_writable_in_draft_is_set_on_create(self):
        field = self.env["res.partner"]._fields["ref"]
        for batch_write in (False, True):
            with self.subTest(batch_write=batch_write):
                ref = f"FI-REF-1-{batch_write}"
                with patch.object(field, "readonly", True), patch.object(
                    field, "states", DRAFT_WRITABLE
                ):
                    partner, vals = self._create_partner(ref, batch_write)
                self.assertEqual(vals.get("ref"), ref, msg=f"create got {vals}")
                self.assertEqual(
                    partner.ref,
                    ref,
                    msg="a readonly field writable in draft must be stored on create",
                )

    def test_readonly_field_without_states_is_skipped_on_create(self):
        field = self.env["res.partner"]._fields["ref"]
        for batch_write in (False, True):
            with self.subTest(batch_write=batch_write):
                with patch.object(field, "readonly", True), patch.object(
                    field, "states", None
                ):
                    partner, vals = self._create_partner("FI-REF-2", batch_write)
                self.assertNotIn(
                    "ref",
                    vals,
                    msg="readonly field without states stays update-only, "
                    f"create got {vals}",
                )
                self.assertFalse(
                    partner.ref,
                    msg="readonly field without states must not be stored on create",
                )
