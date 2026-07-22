"""
Row transformation: maps CSV column names to Odoo field names.

Handles id/.id fields, relational reference suffixes (/id, /.id), and __op__.

A mapped column that is *absent* from the row is skipped entirely. A column
that is *present but empty* ("") is forwarded for regular fields (but not for
special columns) so that resolve_row can apply type-aware handling — an empty
boolean cell must become False, which can only be decided once the field type
is known.

A present-but-non-numeric database id (.id / <field>/.id) raises rather than
being silently dropped, so a broken upsert key surfaces as a per-row error
instead of silently turning an UPDATE into a duplicate CREATE.
"""
from __future__ import annotations

from .constants import (
    FIELD_DB_ID,
    FIELD_EXTERNAL_ID,
    FIELD_ID,
    FIELD_OPERATION,
    SUFFIX_DB_ID,
    SUFFIX_EXTERNAL_ID,
)

# Sentinel distinguishing "column absent from this row" from "column present
# with an empty value". The former is skipped; the latter is forwarded.
_MISSING = object()


def _parse_db_id(value: str, column: str) -> int:
    """Parse a database-ID cell (.id / <field>/.id) to an int.

    A present-but-non-numeric database ID must NOT be silently dropped: doing
    so removes the upsert key, so an intended UPDATE silently becomes a CREATE
    (a duplicate) — and under the standalone retry path the row is classified
    "safe" yet still duplicated. Raise a clear per-row error instead so the row
    fails visibly. transform_row_data is called per row inside a try/except in
    Importer.import_rows, so this fails only the offending row.
    """
    try:
        return int(str(value).strip())
    except (ValueError, TypeError):
        raise ValueError(
            f"{column!r} column has non-numeric database id {value!r} "
            f"(a database id must be an integer)"
        ) from None


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
        value = row_data.get(csv_col, _MISSING)
        if value is _MISSING or value is None:
            continue  # column absent from this row entirely

        # An empty cell in a *special* column carries no meaning: there is no
        # empty external id, operation, or relational reference to write, so
        # skip it exactly as before. Empty cells in *regular* columns, however,
        # are forwarded (see the fall-through below) so that resolve_row can
        # apply type-aware handling — an empty boolean cell must become False,
        # which it can only decide once it knows the field's type.
        is_empty = value == ""

        # Handle id/.id fields specially for upsert
        if odoo_field == FIELD_ID:
            if not is_empty:
                result[FIELD_EXTERNAL_ID] = value
            continue
        if odoo_field == FIELD_DB_ID:
            if not is_empty:
                result[FIELD_ID] = _parse_db_id(value, FIELD_DB_ID)
            continue

        # Handle operation column for explicit operation strategy
        if odoo_field == FIELD_OPERATION:
            if not is_empty:
                result[FIELD_OPERATION] = value
            continue

        # Handle reference suffixes: /.id for database ID, /id for external ID
        if odoo_field.endswith(SUFFIX_DB_ID):
            if not is_empty:
                target_field = odoo_field[: -len(SUFFIX_DB_ID)]
                result[target_field] = _parse_db_id(value, odoo_field)
            continue
        if odoo_field.endswith(SUFFIX_EXTERNAL_ID):
            if not is_empty:
                target_field = odoo_field[: -len(SUFFIX_EXTERNAL_ID)]
                result[target_field] = value
            continue

        # Regular scalar field: forward the value verbatim, INCLUDING an empty
        # string. resolve_row decides what an empty cell means per field type
        # (empty boolean -> False; empty of any other type -> dropped so the
        # existing DB value / create default is preserved).
        result[odoo_field] = value

    return result
