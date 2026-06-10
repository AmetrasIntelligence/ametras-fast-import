"""
Row-level idempotency assessment for standalone (RPC) retry decisions.

Port of 16.0's assessTimeoutRetryIdempotency (TypeScript) to Python.

A row is *safe to retry* if it carries a non-empty external ID ('id') or
database ID ('.id') that the import engine will use for upsert — Odoo's
load() will update the existing record rather than creating a duplicate.

Rows without a key column mapping, or with an empty key value, are *unsafe*:
retrying them risks creating duplicate records.

This check is only consulted in standalone (RPC) mode, and only when the
BatchSizeAdapter is already at minimum batch size.  In embedded mode, ORM
savepoints make every batch idempotent at the row level.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .parser import ParsedRow


@dataclass
class IdempotencyResult:
    safe: list[ParsedRow] = field(default_factory=list)
    unsafe: list[ParsedRow] = field(default_factory=list)
    reason_counts: dict[str, int] = field(default_factory=dict)


def assess_timeout_retry_idempotency(
    rows: list[ParsedRow],
    field_mappings: dict[str, str],
) -> IdempotencyResult:
    """
    Classify rows in *rows* as safe or unsafe to retry after a timeout.

    Args:
        rows: Batch of parsed rows to classify.
        field_mappings: CSV-column → Odoo-field mapping dict
                        (e.g. {'ID': 'id', 'Ext ID': 'id', ...}).

    Returns:
        IdempotencyResult with safe, unsafe lists and per-reason counts.

    Classification:
    - All rows → unsafe with reason 'missing_key_mapping' when neither 'id'
      nor '.id' appears as a mapped target field.
    - Otherwise, per row: if the CSV value for the id or .id column is
      non-empty → safe; else → unsafe with 'empty_external_and_database_id'.
    """
    result = IdempotencyResult()

    # Find CSV column names that map to 'id' and '.id' target fields
    id_col = next((col for col, tgt in field_mappings.items() if tgt == "id"), None)
    dot_id_col = next(
        (col for col, tgt in field_mappings.items() if tgt == ".id"), None
    )

    if id_col is None and dot_id_col is None:
        # No key mapping at all — retrying any row risks a duplicate
        for row in rows:
            result.unsafe.append(row)
        result.reason_counts["missing_key_mapping"] = len(rows)
        return result

    for row in rows:
        id_val = str(row.data.get(id_col, "")).strip() if id_col else ""
        dot_id_val = str(row.data.get(dot_id_col, "")).strip() if dot_id_col else ""

        if id_val or dot_id_val:
            result.safe.append(row)
        else:
            result.unsafe.append(row)
            key = "empty_external_and_database_id"
            result.reason_counts[key] = result.reason_counts.get(key, 0) + 1

    return result
