"""
Batched writes: one load() call per batch instead of one create/write per row.

The batched path must leave the database exactly as the row-by-row path
does. These tests drive the Importer against an in-memory backend whose
load() follows Odoo's contract: text cells, ``.id`` / ``id`` / ``<f>/.id``
columns, and a full rollback with error messages when any row fails.

The real-ORM comparison of both paths is test_batch_write_diff_orm.py.

Run with:
    python3 ametras_fast_import_addon/tests/test_importer_batch_write.py
"""
import os
import sys
import unittest
from unittest.mock import patch

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.backend import FieldInfo, OdooBackend, TransportError  # noqa: E402
from import_engine.constants import CREATE_LOST_MESSAGE  # noqa: E402
from import_engine.importer import ImportConfig, Importer  # noqa: E402
from import_engine.parser import ParsedRow  # noqa: E402

SERIALIZATION_MESSAGE = (
    "could not serialize access due to concurrent update (simulated conflict "
    "with another import worker)"
)


class FakeLoadBackend(OdooBackend):
    """In-memory records with create/write and an Odoo-like load()."""

    supports_load = True
    load_conflicts_retryable = True

    def __init__(self, records=None, conflicts=0, archived=()):
        self.records = {rid: dict(vals) for rid, vals in (records or {}).items()}
        self.xmlids = {}
        self.next_id = max(self.records, default=0) + 1
        self.load_calls = []
        self.row_calls = []
        self.conflicts = conflicts
        self.archived = set(archived)
        self.create_many_calls = []
        self._fields = {
            "code": FieldInfo("code", "char"),
            "name": FieldInfo("name", "char"),
            "price": FieldInfo("price", "float"),
            "active": FieldInfo("active", "boolean"),
            "partner_id": FieldInfo("partner_id", "many2one", "res.partner"),
            "tag_ids": FieldInfo("tag_ids", "many2many", "res.partner.category"),
            "line_ids": FieldInfo("line_ids", "one2many", "sale.order.line"),
            "color": FieldInfo("color", "integer"),
            "ref": FieldInfo("ref", "char"),
            "date_done": FieldInfo("date_done", "datetime"),
            "type": FieldInfo(
                "type",
                "selection",
                selection=[("contact", "Contact"), ("delivery", "Delivery Address")],
            ),
        }

    # -- row-by-row API ----------------------------------------------------

    def _check(self, vals):
        if vals.get("name") == "BAD":
            raise ValueError("Odoo error: Simulated validation error for name BAD")

    def create(self, model, vals):  # pylint: disable=method-required-super
        self.row_calls.append(("create", model, dict(vals)))
        if model == "ir.model.data":
            self.xmlids[(vals["module"], vals["name"])] = vals["res_id"]
            return len(self.xmlids)
        self._check(vals)
        rid = self.next_id
        self.next_id += 1
        self.records[rid] = self._store(vals)
        return rid

    def create_many(self, model, vals_list):
        self.create_many_calls.append((model, [dict(v) for v in vals_list]))
        if model == "ir.model.data":
            for vals in vals_list:
                self.xmlids[(vals["module"], vals["name"])] = vals["res_id"]
            return list(range(len(vals_list)))
        for vals in vals_list:
            self._check(vals)
        ids = []
        for vals in vals_list:
            rid = self.next_id
            self.next_id += 1
            self.records[rid] = self._store(vals)
            ids.append(rid)
        return ids

    def write(self, model, ids, vals):  # pylint: disable=method-required-super
        self.row_calls.append(("write", model, dict(vals)))
        self._check(vals)
        for rid in ids:
            self.records[rid].update(self._store(vals))
        return True

    @staticmethod
    def _store(vals):
        out = dict(vals)
        if "tag_ids" in out:
            out["tag_ids"] = sorted(out["tag_ids"][0][2])
        return out

    def search(self, model, domain, fields=None, limit=None):
        hits = [
            rid for rid, rec in sorted(self.records.items()) if _match(rec, rid, domain)
        ]
        return hits[: limit or None]

    def search_read(self, model, domain, fields, limit=None):
        if model == "ir.model.data":
            names = {f: v for f, _op, v in domain}
            return [
                {"module": m, "name": n, "res_id": rid}
                for (m, n), rid in self.xmlids.items()
                if n in names.get("name", []) or n == names.get("name")
            ]
        return [
            {"id": rid, **{f: self.records[rid].get(f) for f in fields if f != "id"}}
            for rid in self.search(model, domain)
        ]

    def browse_exists(self, model, record_id):
        self.exists_calls = getattr(self, "exists_calls", 0) + 1
        return record_id in self.records and record_id not in self.archived

    def existing_ids(self, model, record_ids):
        return {
            rid
            for rid in record_ids
            if rid in self.records and rid not in self.archived
        }

    def name_search(self, model, value):
        return [
            (rid, rec["name"])
            for rid, rec in sorted(self.records.items())
            if rec.get("name") == value
        ][:2]

    def execute(self, model, method, *args, **kwargs):
        return []

    def get_field_info(self, model):
        return self._fields

    # -- load() --------------------------------------------------------------

    def load(self, model, fields, rows, context):
        self.load_calls.append((list(fields), [list(r) for r in rows]))
        if self.conflicts:
            self.conflicts -= 1
            return {
                "ids": False,
                "messages": [{"type": "error", "message": SERIALIZATION_MESSAGE}],
            }
        snapshot = (
            {k: dict(v) for k, v in self.records.items()},
            dict(self.xmlids),
            self.next_id,
        )
        ids, messages = [], []
        for i, row in enumerate(rows):
            vals, target, xmlid = {}, None, None
            for column, cell in zip(fields, row, strict=True):
                if column == ".id":
                    target = int(cell)
                elif column == "id":
                    xmlid = tuple(cell.split(".", 1))
                    target = self.xmlids.get(xmlid)
                elif column.endswith("/.id"):
                    name = column[:-4]
                    if self._fields[name].type == "many2many":
                        vals[name] = sorted(int(x) for x in cell.split(",") if x)
                    else:
                        vals[name] = int(cell)
                elif self._fields[column].type == "boolean":
                    vals[column] = cell == "1"
                elif self._fields[column].type == "float":
                    vals[column] = float(cell)
                else:
                    vals[column] = cell
            if vals.get("name") == "BAD":
                messages.append(
                    {
                        "type": "error",
                        "message": "Simulated validation error",
                        "rows": {"from": i, "to": i},
                    }
                )
                continue
            if target:
                self.records[target].update(vals)
            else:
                target = self.next_id
                self.next_id += 1
                self.records[target] = vals
                if xmlid:
                    self.xmlids[xmlid] = target
            ids.append(target)
        if messages:
            self.records, self.xmlids, self.next_id = snapshot
            return {"ids": False, "messages": messages}
        return {"ids": ids, "messages": []}


INTEGER_FIELDS = {"color"}


def _server_value(field, value):
    """The server converts a domain value to the field's type."""
    if field in INTEGER_FIELDS and value not in (None, False):
        return int(value)
    return value


def _match(rec, rid, domain):
    for _field, op, value in [t for t in domain if isinstance(t, tuple)]:
        current = rid if _field == "id" else rec.get(_field)
        current = _server_value(_field, current)
        if op == "=":
            value = _server_value(_field, value)
        if op == "in":
            value = [_server_value(_field, v) for v in value]
        if op == "=" and current != value:
            return False
        if op == "in" and current not in value:
            return False
    return True


def rows_of(*dicts):
    return [ParsedRow(index=i + 1, data=d) for i, d in enumerate(dicts)]


def importer(backend, **config):
    defaults = dict(
        model="product.template",
        field_mappings={},
        batch_size=50,
        batch_write=True,
    )
    defaults.update(config)
    return Importer(backend, ImportConfig(**defaults))


class TestBatchedUpdates(unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.backend = FakeLoadBackend(
            {
                1: {"code": "A", "name": "a", "price": 1.0},
                2: {"code": "B", "name": "b", "price": 2.0},
                3: {"code": "C", "name": "c", "price": 3.0},
            }
        )

    def test_one_load_call_for_the_batch(self):
        results = importer(self.backend, search_keys=["code"]).import_rows(
            rows_of(
                {"code": "A", "price": "10.5"},
                {"code": "B", "price": "20"},
                {"code": "C", "price": "30"},
            )
        )
        self.assertEqual([r.ok for r in results], [True, True, True])
        self.assertEqual([r.action for r in results], ["updated"] * 3)
        self.assertEqual([r.record_id for r in results], [1, 2, 3])
        self.assertEqual(
            len(self.backend.load_calls), 1, msg="The batch must be one load() call"
        )
        self.assertEqual(self.backend.row_calls, [], msg="No create/write per row")
        self.assertEqual(
            [self.backend.records[i]["price"] for i in (1, 2, 3)], [10.5, 20.0, 30.0]
        )

    def test_column_missing_in_a_row_is_not_cleared(self):
        importer(self.backend, search_keys=["code"]).import_rows(
            rows_of({"code": "A", "price": "10"}, {"code": "B", "name": "new b"})
        )
        self.assertEqual(
            self.backend.records[1]["name"],
            "a",
            msg="Row A did not set name; it must stay",
        )
        self.assertEqual(
            self.backend.records[2]["price"],
            2.0,
            msg="Row B did not set price; it must stay",
        )
        self.assertEqual(self.backend.records[2]["name"], "new b")
        self.assertEqual(
            len(self.backend.load_calls),
            2,
            msg="Rows with other columns go into another load()",
        )

    def test_repeated_record_keeps_the_last_row(self):
        importer(self.backend, search_keys=["code"]).import_rows(
            rows_of(
                {"code": "A", "price": "1"},
                {"code": "B", "price": "2"},
                {"code": "A", "price": "3"},
            )
        )
        self.assertEqual(self.backend.records[1]["price"], 3.0)
        self.assertEqual(
            len(self.backend.load_calls), 2, msg="A repeated record starts a new load()"
        )

    def test_failing_row_is_isolated_and_reports_the_row_error(self):
        results = importer(self.backend, search_keys=["code"]).import_rows(
            rows_of(
                {"code": "A", "price": "10"},
                {"code": "B", "name": "BAD"},
                {"code": "C", "price": "30"},
            )
        )
        self.assertEqual([r.ok for r in results], [True, False, True])
        self.assertIn(
            "Simulated validation error for name BAD",
            results[1].error,
            msg="The failing row must carry the row-by-row error message",
        )
        self.assertEqual(results[1].row_index, 2)
        self.assertEqual(self.backend.records[1]["price"], 10.0)
        self.assertEqual(self.backend.records[3]["price"], 30.0)
        self.assertEqual(
            self.backend.records[2]["name"],
            "b",
            msg="The failing row must not be written",
        )

    def test_conflict_reported_by_load_is_retried(self):
        self.backend.conflicts = 2
        with patch.object(Importer, "_backoff"):
            results = importer(self.backend, search_keys=["code"]).import_rows(
                rows_of({"code": "A", "price": "10"}, {"code": "B", "price": "20"})
            )
        self.assertEqual([r.ok for r in results], [True, True])
        self.assertEqual(
            len(self.backend.load_calls), 3, msg="Two conflicts, then success"
        )
        self.assertEqual(
            self.backend.row_calls,
            [],
            msg="A conflict must not fall back to row-by-row",
        )

    def test_relational_and_boolean_cells(self):
        mapping = {c: c for c in ("code", "partner_id/.id", "tag_ids/.id", "active")}
        importer(
            self.backend, search_keys=["code"], field_mappings=mapping
        ).import_rows(
            rows_of(
                {
                    "code": "A",
                    "partner_id/.id": "2",
                    "tag_ids/.id": "3,5",
                    "active": "0",
                }
            )
        )
        fields, rows = self.backend.load_calls[0]
        cells = dict(zip(fields, rows[0], strict=True))
        self.assertEqual(cells["partner_id/.id"], "2")
        self.assertEqual(cells["tag_ids/.id"], "3,5")
        self.assertEqual(cells["active"], "0")
        self.assertEqual(self.backend.records[1]["partner_id"], 2)
        self.assertEqual(self.backend.records[1]["tag_ids"], [3, 5])
        self.assertIs(self.backend.records[1]["active"], False)

    def test_unknown_database_id_fails_like_row_by_row(self):
        results = importer(self.backend).import_rows(rows_of({"id": 99, "price": "1"}))
        self.assertFalse(results[0].ok)
        self.assertEqual(
            results[0].error, "Record with .id=99 not found in product.template"
        )


class TestBatchedCreates(unittest.TestCase):
    def test_external_id_creates_once_then_updates(self):
        backend = FakeLoadBackend()
        imp = importer(backend, use_external_id=True)
        results = imp.import_rows(
            rows_of(
                {"__external_id__": "p1", "name": "one", "price": "1"},
                {"__external_id__": "p2", "name": "two", "price": "2"},
                {"__external_id__": "__import__.p1", "name": "one", "price": "9"},
            )
        )
        self.assertEqual([r.action for r in results], ["created", "created", "updated"])
        self.assertEqual(len(backend.records), 2, msg="p1 must exist once")
        p1 = backend.xmlids[("__import__", "p1")]
        self.assertEqual(backend.records[p1]["price"], 9.0)
        self.assertEqual(results[2].record_id, p1)

    def test_plain_creates_in_one_call(self):
        backend = FakeLoadBackend()
        results = importer(backend, model="product.supplierinfo").import_rows(
            rows_of({"name": "x", "price": "1"}, {"name": "y", "price": "2"})
        )
        self.assertEqual([r.ok for r in results], [True, True])
        self.assertEqual(
            backend.load_calls, [], msg="New records are created, not loaded"
        )
        self.assertEqual(
            len(backend.create_many_calls), 1, msg="One create() for the batch"
        )
        self.assertEqual([r["name"] for r in backend.records.values()], ["x", "y"])

    def test_creates_keep_file_order_with_different_columns(self):
        backend = FakeLoadBackend()
        importer(backend, model="product.supplierinfo").import_rows(
            rows_of(
                {"name": "first", "price": "1"},
                {"name": "second"},
                {"name": "third", "price": "3"},
            )
        )
        self.assertEqual(len(backend.create_many_calls), 1)
        self.assertEqual(
            [v["name"] for v in backend.create_many_calls[0][1]],
            ["first", "second", "third"],
            msg="New records must be created in file order",
        )

    def test_failing_create_is_isolated(self):
        backend = FakeLoadBackend()
        results = importer(backend, model="product.supplierinfo").import_rows(
            rows_of({"name": "ok 1"}, {"name": "BAD"}, {"name": "ok 2"})
        )
        self.assertEqual([r.ok for r in results], [True, False, True])
        self.assertIn("Simulated validation error for name BAD", results[1].error)
        self.assertEqual(
            sorted(r["name"] for r in backend.records.values()), ["ok 1", "ok 2"]
        )


class TestReferencedIdsCheckedOncePerBatch(unittest.TestCase):
    """A many2one by database id is checked for existence once per batch,
    not with one call per row."""

    def setUp(self):
        super().setUp()
        self.backend = FakeLoadBackend(
            {
                1: {"code": "A", "name": "a"},
                2: {"code": "B", "name": "b"},
                3: {"code": "C", "name": "c"},
            }
        )
        self.mapping = {"code": "code", "partner_id/.id": "partner_id/.id"}

    def test_no_existence_call_per_row(self):
        results = importer(
            self.backend, search_keys=["code"], field_mappings=self.mapping
        ).import_rows(
            rows_of(
                {"code": "A", "partner_id/.id": "2"},
                {"code": "B", "partner_id/.id": "3"},
                {"code": "C", "partner_id/.id": "2"},
            )
        )
        self.assertEqual([r.ok for r in results], [True, True, True])
        self.assertEqual(
            getattr(self.backend, "exists_calls", 0),
            0,
            msg="Referenced ids must be checked in bulk, not per row",
        )
        self.assertEqual(self.backend.records[1]["partner_id"], 2)

    def test_missing_referenced_id_still_fails_its_row(self):
        results = importer(
            self.backend, search_keys=["code"], field_mappings=self.mapping
        ).import_rows(
            rows_of(
                {"code": "A", "partner_id/.id": "2"},
                {"code": "B", "partner_id/.id": "77"},
            )
        )
        self.assertTrue(results[0].ok)
        self.assertFalse(results[1].ok)
        self.assertEqual(results[1].error, "Record 77 not found in res.partner")


class TestReferenceToRecordOfTheSameBatch(unittest.TestCase):
    def test_reference_by_name_to_a_record_created_earlier_in_the_batch(self):
        """A contact naming a company created two rows above (row by row, the
        company exists when the contact is resolved)."""
        backend = FakeLoadBackend()
        mapping = {"name": "name", "partner_id": "partner_id"}
        results = importer(
            backend, model="res.partner", field_mappings=mapping
        ).import_rows(
            rows_of(
                {"name": "Parent Co"},
                {"name": "Other"},
                {"name": "Contact", "partner_id": "Parent Co"},
            )
        )
        self.assertEqual(
            [r.ok for r in results],
            [True, True, True],
            msg=f"errors: {[r.error for r in results]}",
        )
        parent = next(r for r, v in backend.records.items() if v["name"] == "Parent Co")
        contact = next(v for v in backend.records.values() if v["name"] == "Contact")
        self.assertEqual(contact["partner_id"], parent)

    def test_unresolvable_reference_still_fails(self):
        backend = FakeLoadBackend()
        mapping = {"name": "name", "partner_id": "partner_id"}
        results = importer(
            backend, model="res.partner", field_mappings=mapping
        ).import_rows(rows_of({"name": "A"}, {"name": "B", "partner_id": "Nobody"}))
        self.assertTrue(results[0].ok)
        self.assertFalse(results[1].ok)
        self.assertIn("Nobody", results[1].error)


class TestReviewFindings(unittest.TestCase):
    """Cases where a batched write could differ from the row-by-row write."""

    def test_integer_search_key_updates_the_record(self):
        """The cell "7" must find the record with color 7, as the server's "="
        does; a plain Python comparison of "7" and 7 would create a duplicate."""
        backend = FakeLoadBackend({1: {"color": 7, "name": "seven"}})
        mapping = {"color": "color", "name": "name"}
        results = importer(
            backend, search_keys=["color"], field_mappings=mapping
        ).import_rows(rows_of({"color": "7", "name": "renamed"}))
        self.assertEqual(results[0].action, "updated", msg=f"result: {results[0]}")
        self.assertEqual(len(backend.records), 1, msg="No duplicate record")
        self.assertEqual(backend.records[1]["name"], "renamed")

    def test_rows_reaching_one_record_through_different_identifiers(self):
        """Row 1 creates a record by external ID and ref, row 2 names only the
        ref: row by row, row 2 updates the record row 1 created."""
        backend = FakeLoadBackend()
        backend._fields["ref"] = FieldInfo("ref", "char")
        mapping = {"id": "id", "ref": "ref", "name": "name"}
        results = importer(
            backend, use_external_id=True, search_keys=["ref"], field_mappings=mapping
        ).import_rows(
            rows_of(
                {"id": "new_x", "ref": "R-1", "name": "A"}, {"ref": "R-1", "name": "B"}
            )
        )
        self.assertEqual([r.action for r in results], ["created", "updated"])
        self.assertEqual(len(backend.records), 1, msg="One record for both rows")
        self.assertEqual(next(iter(backend.records.values()))["name"], "B")

    def test_database_id_and_search_key_of_the_same_record(self):
        backend = FakeLoadBackend({5: {"code": "A", "name": "a", "price": 1.0}})
        mapping = {".id": ".id", "code": "code", "price": "price"}
        importer(backend, search_keys=["code"], field_mappings=mapping).import_rows(
            rows_of({".id": "5", "price": "2"}, {"code": "A", "price": "3"})
        )
        self.assertEqual(
            backend.records[5]["price"], 3.0, msg="The last row of the file wins"
        )

    def test_failing_lookup_writes_the_rows_one_by_one(self):
        """A lookup error must fail only its own row, as row by row."""
        backend = FakeLoadBackend(
            {1: {"code": "A", "name": "a"}, 2: {"code": "B", "name": "b"}}
        )

        def broken_search_read(model, domain, fields, limit=None):
            raise ValueError("Odoo error: Simulated failure of the bulk lookup")

        backend.search_read = broken_search_read
        results = importer(backend, search_keys=["code"]).import_rows(
            rows_of({"code": "A", "name": "new a"}, {"code": "B", "name": "new b"})
        )
        self.assertEqual([r.ok for r in results], [True, True], msg=f"{results}")
        self.assertEqual(backend.records[1]["name"], "new a")
        self.assertEqual(backend.load_calls, [])

    def test_datetime_update_is_written_row_by_row(self):
        backend = FakeLoadBackend({1: {"code": "A"}})
        mapping = {"code": "code", "date_done": "date_done"}
        importer(backend, search_keys=["code"], field_mappings=mapping).import_rows(
            rows_of({"code": "A", "date_done": "2026-11-07 10:00:00"})
        )
        self.assertEqual(
            backend.load_calls, [], msg="load() reads datetimes in the user's time zone"
        )
        self.assertEqual(backend.records[1]["date_done"], "2026-11-07 10:00:00")

    def test_update_of_a_model_outside_the_list_is_row_by_row(self):
        backend = FakeLoadBackend({1: {"code": "A", "price": 1.0}})
        importer(backend, model="stock.quant", search_keys=["code"]).import_rows(
            rows_of({"code": "A", "price": "5"})
        )
        self.assertEqual(
            backend.load_calls, [], msg="stock.quant has its own load() hooks"
        )
        self.assertEqual(backend.row_calls[0][0], "write")

    def test_archived_record_behind_an_external_id_goes_row_by_row(self):
        backend = FakeLoadBackend({1: {"name": "old"}}, archived={1})
        backend.xmlids[("__import__", "arch")] = 1
        importer(backend, use_external_id=True).import_rows(
            rows_of({"__external_id__": "arch", "name": "new"})
        )
        self.assertEqual(backend.load_calls, [])
        self.assertEqual(
            backend.create_many_calls,
            [],
            msg="No batched create over an existing external ID",
        )

    def test_rows_load_skips_with_a_warning_are_not_sent_again(self):
        backend = FakeLoadBackend({1: {"code": "A"}, 2: {"code": "B"}})
        real_load = backend.load

        def load_skipping_first_row(model, fields, rows, context):
            result = real_load(model, fields, rows, context)
            result["ids"] = result["ids"][1:]
            result["messages"].append(
                {
                    "type": "warning",
                    "message": "Simulated warning for the first row",
                    "rows": {"from": 0, "to": 0},
                }
            )
            return result

        backend.load = load_skipping_first_row
        results = importer(backend, search_keys=["code"]).import_rows(
            rows_of({"code": "A", "price": "1"}, {"code": "B", "price": "2"})
        )
        self.assertEqual([r.ok for r in results], [False, True])
        self.assertEqual(results[0].error, "Simulated warning for the first row")
        self.assertEqual(results[1].record_id, 2)
        self.assertEqual(backend.row_calls, [], msg="Nothing may be sent again")

    def test_conflicts_are_not_retried_inside_one_transaction(self):
        """In ORM mode every load() runs in the same transaction: a retry
        cannot succeed, the rows go row by row instead."""
        backend = FakeLoadBackend({1: {"code": "A", "price": 1.0}}, conflicts=1)
        backend.load_conflicts_retryable = False
        importer(backend, search_keys=["code"]).import_rows(
            rows_of({"code": "A", "price": "5"})
        )
        self.assertEqual(len(backend.load_calls), 1)
        self.assertEqual(backend.row_calls[0][0], "write")


class TestSecondReviewRound(unittest.TestCase):
    def test_lost_connection_during_create_fails_rows_without_sending_again(self):
        backend = FakeLoadBackend()

        def create_many_times_out(model, vals_list):
            backend.create_many_calls.append((model, vals_list))
            raise TransportError("Simulated timeout of the batched create")

        backend.create_many = create_many_times_out
        results = importer(backend, model="product.supplierinfo").import_rows(
            rows_of({"name": "x"}, {"name": "y"})
        )
        self.assertEqual([r.ok for r in results], [False, False])
        self.assertEqual({r.error for r in results}, {CREATE_LOST_MESSAGE})
        self.assertEqual(
            len(backend.create_many_calls), 1, msg="The create is never sent again"
        )
        self.assertEqual(
            backend.row_calls, [], msg="No row-by-row create after a lost connection"
        )

    def test_reference_written_by_name_and_by_id_is_one_record(self):
        backend = FakeLoadBackend({1: {"name": "Parent Co"}})
        mapping = {"P": "partner_id", "Pid": "partner_id/.id", "code": "code"}
        importer(
            backend, search_keys=["partner_id"], field_mappings=mapping
        ).import_rows(
            rows_of({"P": "Parent Co", "code": "first"}, {"Pid": "1", "code": "second"})
        )
        created = [r for rid, r in backend.records.items() if rid != 1]
        self.assertEqual(len(created), 1, msg="Both rows name partner 1: one record")
        self.assertEqual(created[0]["code"], "second")

    def test_numeric_key_written_differently_is_one_record(self):
        backend = FakeLoadBackend()
        mapping = {"color": "color", "name": "name"}
        importer(backend, search_keys=["color"], field_mappings=mapping).import_rows(
            rows_of({"color": "7", "name": "first"}, {"color": "07", "name": "second"})
        )
        self.assertEqual(
            len(backend.records), 1, msg='"7" and "07" are the same key for the server'
        )
        self.assertEqual(next(iter(backend.records.values()))["name"], "second")

    def test_failing_existence_prefetch_checks_each_row(self):
        backend = FakeLoadBackend({1: {"code": "A"}, 2: {"name": "P"}})
        real = backend.existing_ids

        def existing_ids_denied(model, ids):
            if model == "res.partner":
                raise ValueError("Odoo error: Simulated access error on res.partner")
            return real(model, ids)

        backend.existing_ids = existing_ids_denied
        mapping = {"code": "code", "partner_id/.id": "partner_id/.id"}
        results = importer(
            backend, search_keys=["code"], field_mappings=mapping
        ).import_rows(rows_of({"code": "A", "partner_id/.id": "2"}))
        self.assertTrue(results[0].ok, msg=f"{results[0]}")
        self.assertEqual(backend.records[1]["partner_id"], 2)

    def test_conflicts_retried_for_the_whole_group_only(self):
        backend = FakeLoadBackend(
            {1: {"code": "A", "price": 1.0}, 2: {"code": "B", "price": 1.0}},
            conflicts=99,
        )
        with patch.object(Importer, "_backoff"):
            importer(backend, search_keys=["code"]).import_rows(
                rows_of({"code": "A", "price": "5"}, {"code": "B", "price": "6"})
            )
        # 1 try + 5 retries for the group, then one try per half, no retries
        self.assertEqual(len(backend.load_calls), 8)

    def test_selection_value_that_is_not_a_key_goes_row_by_row(self):
        backend = FakeLoadBackend({1: {"code": "A"}})
        mapping = {"code": "code", "type": "type"}
        importer(backend, search_keys=["code"], field_mappings=mapping).import_rows(
            rows_of({"code": "A", "type": "DELIVERY"})
        )
        self.assertEqual(
            backend.load_calls, [], msg="load() would accept another letter case"
        )
        importer(backend, search_keys=["code"], field_mappings=mapping).import_rows(
            rows_of({"code": "A", "type": "delivery"})
        )
        self.assertEqual(
            len(backend.load_calls), 1, msg="An exact key goes through load()"
        )


class TestThirdReviewRound(unittest.TestCase):
    def test_name_reference_sees_records_created_above(self):
        """A file that creates a second "Co" and then names "Co": row by row
        the name is ambiguous; the batched write must not link the old one."""
        backend = FakeLoadBackend({1: {"name": "Co"}})
        mapping = {"name": "name", "partner_id": "partner_id"}
        results = importer(
            backend, model="res.partner", field_mappings=mapping
        ).import_rows(rows_of({"name": "Co"}, {"name": "Contact", "partner_id": "Co"}))
        self.assertTrue(results[0].ok)
        self.assertFalse(
            results[1].ok, msg="Two records named Co: the reference is ambiguous"
        )
        self.assertIn("ambiguous", results[1].error)

    def test_external_id_lookup_filters_on_module(self):
        backend = FakeLoadBackend()
        domains = []
        real = backend.search_read

        def recording_search_read(model, domain, fields, limit=None):
            if model == "ir.model.data":
                domains.append(domain)
            return real(model, domain, fields, limit)

        backend.search_read = recording_search_read
        importer(backend, use_external_id=True).import_rows(
            rows_of({"__external_id__": "a", "name": "A"})
        )
        self.assertTrue(
            any(term[0] == "module" for term in domains[0] if isinstance(term, tuple)),
            msg="The lookup must use the (module, name) index",
        )


class TestBatchWriteIsOptIn(unittest.TestCase):
    def test_default_config_writes_row_by_row(self):
        backend = FakeLoadBackend({1: {"code": "A", "price": 1.0}})
        Importer(
            backend,
            ImportConfig(
                model="product.template", field_mappings={}, search_keys=["code"]
            ),
        ).import_rows(rows_of({"code": "A", "price": "5"}))
        self.assertEqual(
            backend.load_calls, [], msg="Batched writes are off unless switched on"
        )
        self.assertEqual(backend.create_many_calls, [])
        self.assertEqual(backend.row_calls[0][0], "write")


class TestRowByRowFallback(unittest.TestCase):
    def test_disabled_batch_write_uses_create_and_write(self):
        backend = FakeLoadBackend({1: {"code": "A", "price": 1.0}})
        importer(backend, search_keys=["code"], batch_write=False).import_rows(
            rows_of({"code": "A", "price": "5"})
        )
        self.assertEqual(backend.load_calls, [])
        self.assertEqual(backend.row_calls[0][0], "write")

    def test_explicit_operation_row_is_written_row_by_row(self):
        backend = FakeLoadBackend({1: {"code": "A", "price": 1.0}})
        importer(backend, search_keys=["code"]).import_rows(
            rows_of(
                {"code": "A", "price": "5"},
                {"__op__": "create", "code": "Z", "price": "1"},
            )
        )
        self.assertEqual(
            len(backend.load_calls), 1, msg="Only the plain row goes through load()"
        )
        self.assertEqual(backend.row_calls[0][0], "create")

    def test_value_without_load_form_is_written_row_by_row(self):
        backend = FakeLoadBackend({1: {"code": "A", "price": 1.0}})
        importer(backend, search_keys=["code"]).import_rows(
            rows_of({"code": "A", "line_ids": [(0, 0, {"name": "l"})]})
        )
        self.assertEqual(
            backend.load_calls, [], msg="one2many values have no load() form"
        )
        self.assertEqual(backend.row_calls[0][0], "write")

    def test_dry_run_stays_row_by_row(self):
        backend = FakeLoadBackend({1: {"code": "A", "price": 1.0}})
        importer(backend, search_keys=["code"], dry_run=True).import_rows(
            rows_of({"code": "A", "price": "5"})
        )
        self.assertEqual(backend.load_calls, [])


if __name__ == "__main__":
    unittest.main()
