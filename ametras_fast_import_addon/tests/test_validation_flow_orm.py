"""Real-ORM tests for the post-import validation server flow.

Covers the pieces the pure/engine tests don't: ValidationRunner (per-file loop,
failedIndices exclusion, progress), csv.import.log._execute_validation (state
transitions + persisted result), and the auto-validate hook in
ImportJob._finalize. Runs in the release-gated test-odoo job.

    odoo-bin -d <db> -i ametras_fast_import_addon --test-enable \\
        --test-tags /ametras_fast_import_addon
"""
import base64
import json

from odoo import fields
from odoo.tests import TransactionCase, tagged

from odoo.addons.ametras_fast_import_addon.models.import_job import ImportJob
from odoo.addons.ametras_fast_import_addon.models.validation_run import ValidationRunner


@tagged("post_install", "-at_install")
class TestValidationFlowOrm(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Partner = cls.env["res.partner"]
        cls.Log = cls.env["csv.import.log"]
        cls.Attachment = cls.env["ir.attachment"]

    def _csv(self, name, content):
        return self.Attachment.create(
            {"name": name, "datas": base64.b64encode(content.encode("utf-8")).decode()}
        )

    def _log(
        self,
        attachment,
        filename,
        field_mappings=None,
        file_progress=None,
        auto_validate=False,
    ):
        job_config = {
            "settings": {
                "encoding": "utf-8",
                "delimiter": ",",
                "batchSize": 100,
                "autoValidate": auto_validate,
                "dryRun": False,
            },
            "importSequence": [filename],
            "fileMappings": {
                filename: {
                    "model": "res.partner",
                    "fieldMappings": field_mappings or {"Ref": "ref", "N": "name"},
                    "searchKeys": ["ref"],
                }
            },
        }
        return self.Log.create(
            {
                "started_at": fields.Datetime.now(),
                "attachment_ids": [(6, 0, attachment.ids)],
                "filenames": json.dumps([filename]),
                "job_config": json.dumps(job_config),
                "file_progress": json.dumps(file_progress or {}),
            }
        )

    # -- ValidationRunner ----------------------------------------------------

    def test_runner_reports_and_excludes_failed_rows(self):
        for ref in ("VR1", "VR2", "VR3"):
            self.Partner.create({"ref": ref, "name": ref})
        # Row 2 (VR2) "failed import" and carries a name that WOULD mismatch —
        # it must be excluded, so the run stays clean.
        att = self._csv("vr.csv", "Ref,N\nVR1,VR1\nVR2,WRONG\nVR3,VR3\n")
        log = self._log(att, "vr.csv", file_progress={"vr.csv": {"failedIndices": [2]}})

        result = ValidationRunner(log).run()

        self.assertEqual(result["checked"], 2)  # VR1 + VR3 only
        self.assertEqual(result["failedRows"], 0)
        self.assertEqual(result["progress"]["filesTotal"], 1)
        self.assertEqual(result["progress"]["filesDone"], 1)
        self.assertIn("vr.csv", result["perFile"])

    def test_runner_flags_dropped_field(self):
        p = self.Partner.create({"ref": "VD1", "name": "VD1", "function": "orig"})
        att = self._csv("vd.csv", "Ref,Fn\nVD1,orig\n")
        log = self._log(att, "vd.csv", field_mappings={"Ref": "ref", "Fn": "function"})
        p.function = False  # simulate a silent drop after import

        result = ValidationRunner(log).run()

        self.assertEqual(result["checked"], 1)
        self.assertEqual(result["failedRows"], 1)
        m = result["perFile"]["vd.csv"]["mismatches"][0]
        self.assertEqual(m["field"], "function")
        self.assertEqual(m["kind"], "dropped")

    # -- csv.import.log._execute_validation ----------------------------------

    def test_execute_validation_passed(self):
        self.Partner.create({"ref": "VE1", "name": "VE1"})
        log = self._log(self._csv("ve.csv", "Ref,N\nVE1,VE1\n"), "ve.csv")

        log._execute_validation()

        self.assertEqual(log.validation_state, "passed")
        self.assertEqual(json.loads(log.validation_result)["checked"], 1)

    def test_execute_validation_failed(self):
        p = self.Partner.create({"ref": "VF1", "name": "VF1", "function": "orig"})
        log = self._log(
            self._csv("vf.csv", "Ref,Fn\nVF1,orig\n"),
            "vf.csv",
            field_mappings={"Ref": "ref", "Fn": "function"},
        )
        p.function = False

        log._execute_validation()

        self.assertEqual(log.validation_state, "failed")

    # -- auto-validate hook (ImportJob._finalize) ----------------------------

    def test_finalize_triggers_autovalidate(self):
        log = self._log(
            self._csv("fa.csv", "Ref,N\nX,X\n"), "fa.csv", auto_validate=True
        )
        ImportJob(log)._finalize("completed", 1, 0, [], {})
        # action_validate writes state 'running' synchronously before enqueuing.
        self.assertEqual(log.validation_state, "running")

    def test_finalize_no_autovalidate_when_off(self):
        log = self._log(
            self._csv("fb.csv", "Ref,N\nX,X\n"), "fb.csv", auto_validate=False
        )
        ImportJob(log)._finalize("completed", 1, 0, [], {})
        self.assertEqual(log.validation_state, "not_run")

    def test_finalize_no_autovalidate_on_failure(self):
        log = self._log(
            self._csv("fc.csv", "Ref,N\nX,X\n"), "fc.csv", auto_validate=True
        )
        # A failed/interrupted import must not auto-validate.
        ImportJob(log)._finalize("failed", 0, 1, [], {})
        self.assertEqual(log.validation_state, "not_run")
