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
    """OrmBackend that keeps the values handed to create()."""

    def __init__(self, env):
        super().__init__(env)
        self.created_vals = []

    def create(self, model, vals):
        self.created_vals.append(dict(vals))
        return super().create(model, vals)


class TestReadonlyStatesOrm(TransactionCase):
    def _create_partner(self, ref):
        backend = RecordingOrmBackend(self.env)
        importer = Importer(
            backend,
            ImportConfig(model="res.partner", field_mappings={"N": "name", "R": "ref"}),
        )
        results = importer.import_rows(
            [ParsedRow(index=1, data={"N": "FI readonly states", "R": ref})]
        )
        self.assertTrue(results[0].ok, results[0].error)
        partner = self.env["res.partner"].browse(results[0].record_id)
        return partner, backend.created_vals[0]

    def test_field_writable_in_draft_is_set_on_create(self):
        field = self.env["res.partner"]._fields["ref"]
        with patch.object(field, "readonly", True), patch.object(
            field, "states", DRAFT_WRITABLE
        ):
            partner, vals = self._create_partner("FI-REF-1")
        self.assertEqual(vals.get("ref"), "FI-REF-1", msg=f"create() got {vals}")
        self.assertEqual(
            partner.ref,
            "FI-REF-1",
            msg="a readonly field writable in draft must be stored on create",
        )

    def test_readonly_field_without_states_is_skipped_on_create(self):
        field = self.env["res.partner"]._fields["ref"]
        with patch.object(field, "readonly", True), patch.object(field, "states", None):
            _partner, vals = self._create_partner("FI-REF-2")
        self.assertNotIn(
            "ref",
            vals,
            msg=f"readonly field without states stays update-only, create() got {vals}",
        )
