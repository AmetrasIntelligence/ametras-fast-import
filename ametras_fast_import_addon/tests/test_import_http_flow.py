"""Full-chain HTTP integration tests: upload → profile → import → logging.

Run against a real Odoo via ``HttpCase``: hit the actual controllers, store a
real ``ir.attachment`` in the filestore, import into base models through the
real ``queue.job``, and assert exactly what lands in the database — including
different field types and the per-language storage of translatable fields.

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

        # A CSV covering several field types: Char (name/email/ref/function) and
        # an Html "notes" description column.
        csv = (
            b"name,email,ref,function,comment\n"
            b"Alice,alice@example.com,REF-A,Engineer,Alice notes\n"
            b"Bob,bob@example.com,REF-B,Manager,Bob notes\n"
        )

        # 1) Upload — real multipart → real ir.attachment streamed to filestore.
        resp = self.url_open(
            "/ametras_fast_import/file/upload",
            files={"file": ("contacts.csv", csv, "text/csv")},
        )
        self.assertEqual(resp.status_code, 200)
        att_id = int(resp.json()["id"])
        att = self.env["ir.attachment"].browse(att_id)
        self.assertTrue(att.exists())
        self.assertEqual(att.file_size, len(csv))
        self.assertEqual(att.raw, csv)  # content actually persisted

        # 2) Analyze — real header/row detection over the stored file.
        analysis = self._json(
            "/ametras_fast_import/file/analyze", {"file_id": str(att_id)}
        )
        self.assertEqual(analysis["headers"], ["name", "email", "ref", "function", "comment"])
        self.assertEqual(analysis["rowCount"], 2)

        # 3) Create a profile via the controller, then read it back.
        created = self._json(
            "/ametras_fast_import/profile/create",
            {
                "data": {
                    "name": "Contacts Import",
                    "mappings": [{"filename": "contacts.csv", "model": "res.partner"}],
                    "sequence": [{"order": 1, "filename": "contacts.csv"}],
                }
            },
        )
        self.assertNotIn("error", created, f"profile create failed: {created}")
        profile_id = created["id"]
        listed = self._json("/ametras_fast_import/profile/list", {})
        self.assertTrue(any(p["id"] == profile_id for p in listed))

        # 4) Start the import — the controller creates the log and enqueues a
        #    REAL queue.job; run it through the real queue_job runner (Job.perform
        #    is exactly what the worker's /queue_job/runjob invokes).
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
                            "fieldMappings": {
                                "name": "name",
                                "email": "email",
                                "ref": "ref",
                                "function": "function",
                                "comment": "comment",
                            },
                        }
                    },
                    "settings": {},
                    "total_rows": 2,
                    "file_row_counts": {"contacts.csv": 2},
                },
            },
        )
        log_id = start["logId"]

        from odoo.addons.queue_job.job import Job

        job_rec = self.env["queue.job"].search(
            [
                ("model_name", "=", "csv.import.log"),
                ("method_name", "=", "_execute_import"),
            ],
            order="id desc",
            limit=1,
        )
        self.assertTrue(job_rec, "/import/start did not enqueue a queue.job")
        self.assertEqual(job_rec.records.id, log_id)
        job = Job.load(self.env, job_rec.uuid)
        job.perform()
        job.set_done()
        job.store()

        # 5) Logging: the log reflects a completed, fully-successful 2-row import.
        log = self._json("/ametras_fast_import/log/get", {"log_id": log_id})["log"]
        self.assertEqual(log["total_rows"], 2)
        self.assertEqual(log["success_rows"], 2)
        self.assertEqual(log["failed_rows"], 0)
        self.assertEqual(log["state"], "completed")

        # 6) Verify EXACTLY what landed in the DB — per record, per field type.
        Partner = self.env["res.partner"]
        alice = Partner.search([("email", "=", "alice@example.com")])
        bob = Partner.search([("email", "=", "bob@example.com")])
        self.assertEqual(len(alice), 1)
        self.assertEqual(len(bob), 1)
        self.assertEqual(alice.name, "Alice")
        self.assertEqual(alice.ref, "REF-A")
        self.assertEqual(alice.function, "Engineer")
        self.assertIn("Alice notes", str(alice.comment or ""))
        self.assertEqual(bob.name, "Bob")
        self.assertEqual(bob.ref, "REF-B")
        self.assertEqual(bob.function, "Manager")
        self.assertIn("Bob notes", str(bob.comment or ""))
        # No stray records: exactly the two rows we imported.
        self.assertEqual(
            Partner.search_count(
                [("email", "in", ["alice@example.com", "bob@example.com"])]
            ),
            2,
        )

    def test_multilanguage_translatable_field(self):
        """A translatable field imported under de_DE / en_US stores both languages."""
        self.authenticate("admin", "admin")
        self.env["res.lang"]._activate_lang("de_DE")

        # Create the tag in English (res.partner.category.name is translate=True).
        created = self._json(
            "/ametras_fast_import/run",
            {
                "model": "res.partner.category",
                "raw_rows": [{"name": "Gold"}],
                "field_mappings": {"name": "name"},
                "lang": "en_US",
            },
        )
        self.assertTrue(created["results"][0]["ok"], created)
        cat_id = created["results"][0]["id"]
        self.assertTrue(cat_id)

        # Update the SAME record's translatable name in German (upsert by db id
        # via a column mapped to ".id"), under the de_DE language context.
        updated = self._json(
            "/ametras_fast_import/run",
            {
                "model": "res.partner.category",
                "raw_rows": [{"rid": str(cat_id), "name": "Gelb"}],
                "field_mappings": {"rid": ".id", "name": "name"},
                "lang": "de_DE",
            },
        )
        self.assertTrue(updated["results"][0]["ok"], updated)
        self.assertEqual(updated["results"][0]["action"], "updated")

        # The two languages are stored independently on the one record.
        cat = self.env["res.partner.category"].browse(cat_id)
        self.assertEqual(cat.with_context(lang="en_US").name, "Gold")
        self.assertEqual(cat.with_context(lang="de_DE").name, "Gelb")
