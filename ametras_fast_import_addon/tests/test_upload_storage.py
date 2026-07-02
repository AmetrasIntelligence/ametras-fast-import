"""Regression tests for addon-mode CSV upload storage.

The upload controller streams the file to the filestore and then registers it
on the attachment. It once passed a bare ``store_fname`` to
``ir.attachment.create``; Odoo ignores ``store_fname`` when no ``raw``/``datas``
is given, so uploaded attachments were created empty and analysis reported 0
rows (with no error). The controller now streams in 64 KB chunks and registers
the pre-written file via ``_store_streamed`` — keeping large-file streaming
while actually persisting the content.

These run under the Odoo test framework (they need a real ir.attachment):
    odoo-bin -d <db> -u ametras_fast_import_addon --test-enable --test-tags \\
        /ametras_fast_import_addon
"""
import io

from odoo.tests import TransactionCase, tagged

from odoo.addons.ametras_fast_import_addon.controllers.file_controller import (
    FileController,
)
from odoo.addons.ametras_fast_import_addon.models.import_engine.parser import (
    analyze_csv,
    analyze_csv_file,
)


@tagged("post_install", "-at_install")
class TestUploadStorage(TransactionCase):

    CSV = b"id,name\n1,Alice\n2,Bob\n3,Carol\n"

    def _upload(self):
        """Mirror the controller: create the record, then stream + register."""
        attachment = self.env["ir.attachment"].create(
            {
                "name": "regression.csv",
                "res_model": "ametras_fast_import.file",
                "res_id": 0,
                "type": "binary",
            }
        )
        FileController._store_streamed(self.env, attachment, io.BytesIO(self.CSV))
        return attachment

    def test_streamed_upload_retains_content(self):
        attachment = self._upload()
        self.assertTrue(
            attachment.store_fname or attachment.db_datas,
            "uploaded attachment has no content",
        )
        self.assertEqual(attachment.raw, self.CSV)
        self.assertEqual(attachment.file_size, len(self.CSV))

    def test_uploaded_attachment_analyses_to_real_row_count(self):
        """The end-to-end contract that failed: upload -> analyze -> N rows."""
        attachment = self._upload()
        if attachment.store_fname:
            result = analyze_csv_file(attachment._full_path(attachment.store_fname))
        else:
            result = analyze_csv(attachment.raw.decode("utf-8", "replace"))
        self.assertEqual(result["rowCount"], 3)
        self.assertEqual(result["headers"], ["id", "name"])

    def test_bare_store_fname_is_ignored_by_odoo(self):
        """Documents why the controller must register, not pass, store_fname."""
        attachment = self.env["ir.attachment"].create(
            {
                "name": "bad.csv",
                "res_model": "ametras_fast_import.file",
                "res_id": 0,
                "type": "binary",
                "store_fname": "ab/abcdef0123456789",
                "file_size": 10,
            }
        )
        self.assertFalse(attachment.store_fname)
