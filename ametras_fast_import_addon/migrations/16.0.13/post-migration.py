"""Rebuild normalized profile child records from the backed-up JSON payloads.

Reads the columns stashed by ``pre-migration.py``, rebuilds the child records
via ``_apply_profile_json`` (which triggers recompute of the JSON interchange
fields), then drops the temporary backup columns.
"""

import json
import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def _loads(text, default):
    try:
        return json.loads(text) if text else default
    except (ValueError, TypeError):
        return default


def migrate(cr, version):
    cr.execute(
        """
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'csv_import_profile'
           AND column_name = 'mappings_bak'
        """
    )
    if not cr.fetchone():
        return

    env = api.Environment(cr, SUPERUSER_ID, {})
    Profile = env["csv.import.profile"]

    cr.execute(
        """
        SELECT id, mappings_bak, sequence_bak, run_settings_bak, field_mappings_bak
          FROM csv_import_profile
        """
    )
    for pid, mappings, sequence, run_settings, field_mappings in cr.fetchall():
        profile = Profile.browse(pid)
        if not profile.exists():
            continue
        # Idempotency: skip profiles that already have normalized children.
        if profile.file_ids or profile.field_mapping_ids or profile.setting_ids:
            continue
        profile._apply_profile_json(
            {
                "mappings": _loads(mappings, []),
                "sequence": _loads(sequence, []),
                "run_settings": _loads(run_settings, {}),
                "field_mappings": _loads(field_mappings, []),
            }
        )
        _logger.info("Migrated profile %s (%s) to normalized children", pid, profile.name)

    cr.execute(
        """
        ALTER TABLE csv_import_profile
            DROP COLUMN IF EXISTS mappings_bak,
            DROP COLUMN IF EXISTS sequence_bak,
            DROP COLUMN IF EXISTS run_settings_bak,
            DROP COLUMN IF EXISTS field_mappings_bak
        """
    )
