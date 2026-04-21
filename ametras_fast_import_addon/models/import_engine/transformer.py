"""
Row transformation: maps CSV column names to Odoo field names.

Port of vue-app/src/utils/rowTransform.ts — identical logic.
Handles id/.id fields, relational reference suffixes (/id, /.id), and __op__.
"""
from __future__ import annotations

from .constants import (
    FIELD_EXTERNAL_ID, FIELD_OPERATION, FIELD_ID, FIELD_DB_ID,
    SUFFIX_DB_ID, SUFFIX_EXTERNAL_ID,
)


def transform_row_data(
    row_data: dict[str, str],
    field_mappings: dict[str, str],
) -> dict[str, str | int]:
    """
    Transform a CSV row's data using field mappings to produce an Odoo-compatible record.

    Args:
        row_data: dict of CSV column name -> value (e.g., {"Partner Name": "Acme"})
        field_mappings: dict of CSV column -> Odoo field (e.g., {"Partner Name": "name"})

    Returns:
        dict of Odoo field name -> value (e.g., {"name": "Acme"})
    """
    result: dict[str, str | int] = {}

    for csv_col, odoo_field in field_mappings.items():
        value = row_data.get(csv_col, '')
        if value is None or value == '':
            continue

        # Handle id/.id fields specially for upsert
        if odoo_field == FIELD_ID:
            result[FIELD_EXTERNAL_ID] = value
            continue
        if odoo_field == FIELD_DB_ID:
            try:
                result[FIELD_ID] = int(value)
            except (ValueError, TypeError):
                pass
            continue

        # Handle operation column for explicit operation strategy
        if odoo_field == FIELD_OPERATION:
            result[FIELD_OPERATION] = value
            continue

        # Handle reference suffixes: /.id for database ID, /id for external ID
        if odoo_field.endswith(SUFFIX_DB_ID):
            try:
                target_field = odoo_field[:-len(SUFFIX_DB_ID)]
                result[target_field] = int(value)
            except (ValueError, TypeError):
                pass
            continue
        if odoo_field.endswith(SUFFIX_EXTERNAL_ID):
            target_field = odoo_field[:-len(SUFFIX_EXTERNAL_ID)]
            result[target_field] = value
            continue

        result[odoo_field] = value

    return result
