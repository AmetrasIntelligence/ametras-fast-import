"""Preserve the JSON profile payloads before they become stored-computed.

In 16.0.2.0.1 the ``mappings`` / ``sequence`` / ``run_settings`` /
``field_mappings`` fields on ``csv.import.profile`` change from plain writable
Text to stored-computed fields backed by normalized child records. When the
new field definitions load, Odoo recomputes them from the (still empty) child
records and would overwrite the existing JSON. We back the values up here so
the post-migration can rebuild the child records from them.
"""


def migrate(cr, version):
    cr.execute(
        """
        ALTER TABLE csv_import_profile
            ADD COLUMN IF NOT EXISTS mappings_bak text,
            ADD COLUMN IF NOT EXISTS sequence_bak text,
            ADD COLUMN IF NOT EXISTS run_settings_bak text,
            ADD COLUMN IF NOT EXISTS field_mappings_bak text
        """
    )
    cr.execute(
        """
        UPDATE csv_import_profile
           SET mappings_bak = mappings,
               sequence_bak = sequence,
               run_settings_bak = run_settings,
               field_mappings_bak = field_mappings
        """
    )
