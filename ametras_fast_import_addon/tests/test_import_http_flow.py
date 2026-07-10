"""Full-chain HTTP integration test: upload → profile → import → logging.

Runs against a real Odoo via ``HttpCase``: it hits the actual controllers,
stores a real ``ir.attachment`` in the filestore, imports into ``res.partner``
through the queue-job path, and asserts the ``csv.import.log`` reflects the run.

    odoo-bin -d <db> -i ametras_fast_import_addon --test-enable \\
        --test-tags /ametras_fast_import_addon
"""
import json

from odoo.tests import HttpCase, tagged


@tagged("post_install", "-at_install")
class TestImportHttpFlow(HttpCase):
    def _json(self, path, params):
        """Call a type='json' controller and return its ``result``."""
        resp = self.url_open(
            path,
            data=json.dumps({"jsonrpc": "2.0", "method": "call", "params": params}),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(resp.status_code, 200, f"{path} -> HTTP {resp.status_code}")
        body = resp.json()
        self.assertNotIn("error", body, f"{path} RPC error: {body.get('error')}")
        return body["result"]

    def test_upload_profile_import_logging(self):
        self.authenticate("admin", "admin")

        # 1) Upload a CSV — real multipart POST → real ir.attachment (streamed
        #    to the filestore). This is the path that once created empty files.
        csv = b"name,email\nAlice,alice@example.com\nBob,bob@example.com\n"
        resp = self.url_open(
            "/ametras_fast_import/file/upload",
            files={"file": ("contacts.csv", csv, "text/csv")},
        )
        self.assertEqual(resp.status_code, 200)
        uploaded = resp.json()
        att_id = int(uploaded["id"])
        self.assertEqual(uploaded["name"], "contacts.csv")

        att = self.env["ir.attachment"].browse(att_id)
        self.assertTrue(att.exists())
        self.assertEqual(att.file_size, len(csv))
        self.assertEqual(att.raw, csv)  # content actually persisted (not empty)

        # 2) Analyze — real header/row detection over the stored file.
        analysis = self._json(
            "/ametras_fast_import/file/analyze", {"file_id": str(att_id)}
        )
        self.assertEqual(analysis["headers"], ["name", "email"])
        self.assertEqual(analysis["rowCount"], 2)

        # 3) Create a profile via the controller, then read it back.
        created = self._json(
            "/ametras_fast_import/profile/create",
            {
                "data": {
                    "name": "Contacts Import",
                    "mappings": [{"filename": "contacts.csv", "model": "res.partner"}],
                    "sequence": [{"order": 1, "filename": "contacts.csv"}],
                    "field_mappings": [
                        {"filename": "contacts.csv", "csvHeader": "name", "odooField": "name"},
                        {"filename": "contacts.csv", "csvHeader": "email", "odooField": "email"},
                    ],
                }
            },
        )
        self.assertNotIn("error", created, f"profile create failed: {created}")
        profile_id = created["id"]
        listed = self._json("/ametras_fast_import/profile/list", {})
        self.assertTrue(
            any(p["id"] == profile_id for p in listed),
            "created profile not returned by /profile/list",
        )

        # 4) Start an import — the real controller creates the csv.import.log and
        #    enqueues the job. Run the enqueued work inline (exactly what the
        #    queue worker does: log._execute_import → ImportJob(log).run()).
        start = self._json(
            "/ametras_fast_import/import/start",
            {
                "file_ids": [att_id],
                "config": {
                    "profile_name": "Contacts Import",
                    "profile_id": profile_id,
                    "importSequence": ["contacts.csv"],
                    "fileMappings": {
                        "contacts.csv": {
                            "model": "res.partner",
                            "fieldMappings": {"name": "name", "email": "email"},
                        }
                    },
                    "settings": {},
                    "total_rows": 2,
                    "file_row_counts": {"contacts.csv": 2},
                },
            },
        )
        log_id = start["logId"]
        self.env["csv.import.log"].browse(log_id)._execute_import()

        # 5) Logging: the log reflects a completed, fully-successful 2-row import.
        got = self._json("/ametras_fast_import/log/get", {"log_id": log_id})
        self.assertTrue(got["ok"], f"log/get failed: {got}")
        log = got["log"]
        self.assertEqual(log["total_rows"], 2)
        self.assertEqual(log["success_rows"], 2)
        self.assertEqual(log["failed_rows"], 0)
        self.assertEqual(log["state"], "completed")

        # 6) The records were actually created in the target model.
        partners = self.env["res.partner"].search(
            [("email", "in", ["alice@example.com", "bob@example.com"])]
        )
        self.assertEqual(len(partners), 2)
        self.assertEqual(set(partners.mapped("name")), {"Alice", "Bob"})
