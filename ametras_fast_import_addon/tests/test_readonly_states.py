# quality: R14 standalone unittest without Odoo, run by the test-python CI job
"""
Readonly fields that a state makes writable (Odoo ``states``).

stock.picking declares picking_type_id, location_id and location_dest_id as
readonly=True with states={'draft': [('readonly', False)]}: a new transfer is a
draft, so they must be written on create. Readonly fields without such a state
stay update-only.

Run with: python3 ametras_fast_import_addon/tests/test_readonly_states.py
"""
import os
import sys
import unittest

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.backend import FieldInfo, OdooBackend, RpcBackend
from import_engine.importer import ImportConfig, Importer
from import_engine.parser import ParsedRow

DRAFT_WRITABLE = {"draft": [["readonly", False]]}

# fields_get of stock.picking as Odoo 13/16 return it over XML-RPC (excerpt)
PICKING_FIELDS_GET = {
    "name": {"type": "char", "readonly": True, "store": True},
    "origin": {"type": "char", "readonly": False, "store": True},
    "picking_type_id": {
        "type": "many2one",
        "relation": "stock.picking.type",
        "readonly": True,
        "store": True,
        "states": DRAFT_WRITABLE,
    },
    "location_id": {
        "type": "many2one",
        "relation": "stock.location",
        "readonly": True,
        "store": True,
        "states": DRAFT_WRITABLE,
    },
    "date_done": {
        "type": "datetime",
        "readonly": True,
        "store": True,
        "states": {"done": [["readonly", True]]},
    },
    "move_count": {"type": "integer", "readonly": True, "store": False},
}


class FieldsGetBackend(RpcBackend):
    """RpcBackend whose transport returns a canned fields_get answer."""

    def __init__(self, fields_get):
        super().__init__("http://odoo.invalid", "db", 2, "secret")
        self.fields_get = fields_get
        self.calls = []

    def _call(self, model, method, args, kwargs=None):
        self.calls.append((model, method, args, kwargs))
        if method != "fields_get":
            raise AssertionError(f"Unexpected RPC call {model}.{method} in this test")
        return self.fields_get


class RecordingBackend(OdooBackend):
    """In-memory backend that records the values handed to create/write."""

    def __init__(self, field_info):
        self.field_info = field_info
        self.records = {}
        self.created = []
        self.written = []

    def search(self, model, domain, fields=None, limit=None):
        return []

    def create(self, model, vals):
        rid = len(self.records) + 1
        self.records[rid] = dict(vals)
        self.created.append((model, dict(vals)))
        return rid

    def write(self, model, ids, vals):
        self.written.append((model, list(ids), dict(vals)))
        return True

    def search_read(self, model, domain, fields, limit=None):
        return []

    def execute(self, model, method, *args, **kwargs):
        return None

    def get_field_info(self, model):
        return self.field_info

    def browse_exists(self, model, record_id):
        # Referenced operation types and locations exist; transfers only if created.
        return model != "stock.picking" or record_id in self.records


def _picking_field_info():
    backend = FieldsGetBackend(PICKING_FIELDS_GET)
    return backend.get_field_info("stock.picking")


MAPPING = {
    "Type": "picking_type_id/.id",
    "From": "location_id/.id",
    "Ref": "origin",
    "Number": "name",
    "Done": "date_done",
}
ROW = {
    "Type": "5",
    "From": "8",
    "Ref": "Stock transfer import",
    "Number": "WH/INT/0001",
    "Done": "2026-10-14 10:00:00",
}


class TestRpcFieldInfoStates(unittest.TestCase):
    def test_fields_get_requests_states(self):
        backend = FieldsGetBackend(PICKING_FIELDS_GET)
        backend.get_field_info("stock.picking")
        attributes = backend.calls[0][3]["attributes"]
        self.assertIn(
            "states",
            attributes,
            msg="fields_get must ask for 'states' to know draft-writable fields",
        )

    def test_writable_in_state_only_when_a_state_clears_readonly(self):
        info = _picking_field_info()
        self.assertTrue(info["picking_type_id"].writable_in_state)
        self.assertTrue(info["location_id"].writable_in_state)
        self.assertFalse(
            info["name"].writable_in_state,
            msg="readonly without states is never writable through a state",
        )
        self.assertFalse(
            info["date_done"].writable_in_state,
            msg="a state that sets readonly=True does not make the field writable",
        )
        self.assertFalse(info["origin"].writable_in_state)

    def test_field_info_default_is_not_writable_in_state(self):
        self.assertFalse(FieldInfo(name="x", type="char").writable_in_state)


class TestCreateWritesDraftWritableFields(unittest.TestCase):
    def _import(self, backend, rows, use_external_id=False):
        mapping = dict(MAPPING)
        if use_external_id:
            mapping["Key"] = "id"
        importer = Importer(
            backend,
            ImportConfig(
                model="stock.picking",
                field_mappings=mapping,
                use_external_id=use_external_id,
            ),
        )
        parsed = [ParsedRow(index=i + 1, data=r) for i, r in enumerate(rows)]
        return importer.import_rows(parsed)

    def test_create_keeps_fields_a_draft_state_makes_writable(self):
        backend = RecordingBackend(_picking_field_info())
        results = self._import(backend, [ROW])

        self.assertTrue(results[0].ok, results[0].error)
        self.assertEqual(len(backend.created), 1, msg="one transfer must be created")
        vals = backend.created[0][1]
        self.assertEqual(
            vals.get("picking_type_id"),
            5,
            msg=f"operation type must reach create(), got {vals}",
        )
        self.assertEqual(vals.get("location_id"), 8, msg=f"got {vals}")
        self.assertEqual(vals.get("origin"), "Stock transfer import")

    def test_create_still_skips_readonly_fields_without_writable_state(self):
        backend = RecordingBackend(_picking_field_info())
        self._import(backend, [ROW])

        vals = backend.created[0][1]
        self.assertNotIn(
            "name", vals, msg="readonly field without states stays update-only"
        )
        self.assertNotIn(
            "date_done", vals, msg="a state setting readonly=True gives no write"
        )

    def test_update_still_writes_readonly_stored_fields(self):
        backend = RecordingBackend(_picking_field_info())
        backend.records[7] = {"name": "OLD"}
        importer = Importer(
            backend,
            ImportConfig(
                model="stock.picking", field_mappings={".id": ".id", **MAPPING}
            ),
        )
        results = importer.import_rows([ParsedRow(index=1, data={".id": "7", **ROW})])

        self.assertTrue(results[0].ok, results[0].error)
        self.assertEqual(len(backend.written), 1, msg="existing transfer is updated")
        vals = backend.written[0][2]
        self.assertEqual(vals.get("name"), "WH/INT/0001", msg=f"got {vals}")
        self.assertEqual(vals.get("picking_type_id"), 5, msg=f"got {vals}")


if __name__ == "__main__":
    unittest.main()
