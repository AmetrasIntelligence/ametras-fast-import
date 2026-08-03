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

import re

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


def _parse_db_ids(value: str, column: str) -> int | list[int]:
    """Parse a relational ``<field>/.id`` cell to a database id.

    A single id -> int (many2one, or a single many2many). A comma/pipe-delimited
    list -> list[int] for a many2many (e.g. ``taxes_id/.id = "173,213"``), which
    the resolver wraps into a ``(6, 0, [ids])`` command. Mirrors Odoo's
    model.load, whose ``_str_to_many2many`` splits ``/.id`` values on comma.
    """
    parts = [p.strip() for p in re.split(r"[|,]", str(value)) if p.strip()]
    try:
        ids = [int(p) for p in parts]
    except (ValueError, TypeError):
        raise ValueError(
            f"{column!r} column has non-numeric database id {value!r} "
            f"(a database id must be an integer)"
        ) from None
    if not ids:
        raise ValueError(f"{column!r} column has no database id in {value!r}")
    return ids[0] if len(ids) == 1 else ids


def transform_row_data(
    row_data: dict[str, str],
    field_mappings: dict[str, str],
) -> dict[str, str | int | float]:
    """
    Transform a CSV row's data using field mappings to produce an Odoo-compatible record.

    Args:
        row_data: dict of CSV column name -> value (e.g., {"Partner Name": "Acme"})
        field_mappings: dict of CSV column -> Odoo field (e.g., {"Partner Name": "name"})

    Returns:
        dict of Odoo field name -> value (e.g., {"name": "Acme"})
    """
    result: dict[str, str | int | float] = {}

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

        # Handle reference suffixes: /.id for database ID, /id for external ID.
        # A relational /.id may carry MULTIPLE ids for a many2many (comma/pipe
        # delimited, e.g. taxes_id/.id = "173,213") — parse to a list; the
        # resolver turns it into a replace command.
        if odoo_field.endswith(SUFFIX_DB_ID):
            if not is_empty:
                target_field = odoo_field[: -len(SUFFIX_DB_ID)]
                result[target_field] = _parse_db_ids(value, odoo_field)
            continue
        if odoo_field.endswith(SUFFIX_EXTERNAL_ID):
            if not is_empty:
                target_field = odoo_field[: -len(SUFFIX_EXTERNAL_ID)]
                result[target_field] = value
            continue

        # Regular scalar field: forward the value to resolve_row, which decides
        # what an empty cell means per field type (empty boolean -> False; empty
        # of any other type -> dropped so the existing DB value / create default
        # is preserved). Two normalisations first — both driven by the typed
        # JSON `raw_rows` API; CSV always delivers strings, so both are no-ops
        # for file imports:
        #
        #   1. A spreadsheet-style integral float (272.0) is de-floated to 272,
        #      so it never lands in a Char as "272.0" nor is misread downstream.
        #   2. A bare number is a *reference*, not a raw database id: stringify
        #      it so resolve_row runs the same xml_id -> name_search path as any
        #      other reference. Only the explicit `/.id` mapping (handled above,
        #      kept as an int) opts into db-id semantics. Mirrors Odoo
        #      model.load (bare value = name; `/.id` = db id) and stops a
        #      business *number* (e.g. manufacturer 272) from silently linking
        #      an unrelated record that merely happens to have database id 272.
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if isinstance(value, int) and not isinstance(value, bool):
            value = str(value)
        result[odoo_field] = value

    return result
