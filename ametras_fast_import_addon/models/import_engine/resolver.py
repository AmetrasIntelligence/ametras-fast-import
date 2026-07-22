"""
Reference resolution for CSV import.

Resolves external ID references (e.g., 'base.de', 'product_category#123')
in relational fields to database record IDs. Uses bulk prefetching for
efficiency (one query per target model instead of one per reference).

All functions are pure Python — no odoo imports.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

from .coercion import coerce_boolean
from .constants import (
    DEFAULT_IMPORT_MODULE,
    FIELD_EXTERNAL_ID,
    FIELD_ID,
    FIELD_OPERATION,
    MODEL_IR_MODEL_DATA,
    STANDARD_DB_ID_MODELS,
)

_logger = logging.getLogger(__name__)

# Re-export for backward compatibility
__all__ = [
    "STANDARD_DB_ID_MODELS",
    "coerce_boolean",
    "is_external_id",
    "parse_refs",
    "normalize_ext_id",
    "lookup_ref",
    "prefetch_references",
    "resolve_row",
]


def is_external_id(value: Any) -> bool:
    """
    Check if value looks like an external ID reference.

    External IDs are strings that are NOT purely numeric.
    Purely numeric strings are treated as database IDs.
    """
    if not isinstance(value, str):
        return False
    return not value.strip().isdigit()


def parse_refs(value: str | None) -> list[str]:
    """
    Parse pipe or comma-delimited references.

    Supports both:
    - "ref1|ref2|ref3" (pipe-delimited, preferred)
    - "ref1,ref2,ref3" (comma-delimited, legacy)
    """
    if not value:
        return []
    delimiter = "|" if "|" in value else ","
    return [x.strip() for x in value.split(delimiter) if x.strip()]


def normalize_ext_id(value: str) -> tuple[str, str]:
    """
    Normalize external ID to (module, name) tuple.

    - "module.name" -> ("module", "name")
    - "name" -> ("__import__", "name")
    """
    value = value.strip()
    if "." in value:
        module, name = value.split(".", 1)
        return (module, name)
    return (DEFAULT_IMPORT_MODULE, value)


def lookup_ref(model_name: str, value: str, ref_map: dict) -> int:
    """
    Lookup resolved ID from prefetch map.

    Raises ValueError if external ID not found.
    """
    module, name = normalize_ext_id(value)
    key = (model_name, module, name)
    if key not in ref_map:
        raise ValueError(f"External ID {value!r} not found for model {model_name}")
    return ref_map[key]


def prefetch_references(
    backend: Any,
    model_name: str,
    field_info: dict,
    rows: list[dict],
) -> dict[tuple[str, str, str], int]:
    """
    Collect and resolve all external ID references in batch.

    Scans all rows for string values in relational fields (many2one, many2many)
    and resolves them via ir.model.data in bulk queries.

    Args:
        backend: OdooBackend instance
        model_name: Target model name (e.g., 'res.partner')
        field_info: dict of field name -> FieldInfo
        rows: List of dicts with field values

    Returns:
        dict: Map of (model_name, module, name) -> res_id
    """
    special_fields = {FIELD_EXTERNAL_ID, FIELD_OPERATION, FIELD_ID}
    refs_by_model: dict[str, set[str]] = defaultdict(set)

    for row in rows:
        for field_name, value in row.items():
            if field_name in special_fields or not value:
                continue
            if field_name not in field_info:
                continue

            field = field_info[field_name]

            if field.type == "many2one" and isinstance(value, str):
                if is_external_id(value):
                    refs_by_model[field.comodel_name].add(value)

            elif field.type == "many2many" and isinstance(value, str):
                if is_external_id(value):
                    for ref in parse_refs(value):
                        refs_by_model[field.comodel_name].add(ref)

    # Resolve all references in bulk (one query per model)
    ref_map: dict[tuple[str, str, str], int] = {}
    for target_model, ext_ids in refs_by_model.items():
        parsed = [(normalize_ext_id(x), x) for x in ext_ids]
        names = [p[0][1] for p in parsed]
        modules = list({p[0][0] for p in parsed})

        imd_records = backend.search_read(
            MODEL_IR_MODEL_DATA,
            [
                ("model", "=", target_model),
                ("module", "in", modules),
                ("name", "in", names),
            ],
            ["module", "name", "res_id"],
        )

        for imd in imd_records:
            ref_map[(target_model, imd["module"], imd["name"])] = imd["res_id"]

    return ref_map


def resolve_row(
    backend: Any,
    model_name: str,
    field_info: dict,
    row: dict,
    ref_map: dict,
) -> tuple[dict, list[str]]:
    """
    Resolve all references in a single row using prefetched map.

    Args:
        backend: OdooBackend instance
        model_name: Target model name
        field_info: dict of field name -> FieldInfo
        row: dict of field values
        ref_map: Prefetched reference map from prefetch_references()

    Returns:
        tuple: (resolved_row dict, list of warning messages)
    """
    resolved: dict = {}
    warnings: list[str] = []

    for field_name, value in row.items():
        # Pass through special fields unchanged
        if field_name in (FIELD_EXTERNAL_ID, FIELD_OPERATION):
            resolved[field_name] = value
            continue

        # Type-aware handling of an empty cell ("" or None).
        #
        # An empty boolean cell means False — mirroring Odoo's import converter
        # (ir_fields._str_to_boolean maps "" -> False). For every other type an
        # empty cell is *dropped* (omitted from the write) so a partial-column
        # update never clobbers the existing DB value, and a create falls back
        # to the field's default. This is why the transformer now forwards
        # empty regular-field values instead of dropping them: only here do we
        # know the field's type.
        if value == "" or value is None:
            info = field_info.get(field_name)
            if info is not None and info.type == "boolean":
                resolved[field_name] = False
            continue

        # Pass through fields not in model
        if field_name not in field_info:
            resolved[field_name] = value
            continue

        field = field_info[field_name]

        # Many2One field resolution
        if field.type == "many2one":
            if isinstance(value, str) and is_external_id(value):
                resolved[field_name] = lookup_ref(field.comodel_name, value, ref_map)
            elif isinstance(value, int):
                # Integer value = database ID (from /.id mapping).
                # Accept for all models — the user explicitly opted in
                # by using the /.id suffix in the field mapping.
                if not backend.browse_exists(field.comodel_name, value):
                    raise ValueError(
                        f"Record {value} not found in {field.comodel_name}"
                    )
                resolved[field_name] = value
                if field.comodel_name not in STANDARD_DB_ID_MODELS:
                    warnings.append(
                        f"Field {field_name!r} uses database ID {value}. "
                        f"Consider migrating to external ID for portability."
                    )
            else:
                resolved[field_name] = value

        # Many2Many field resolution.
        #
        # x2many fields cannot be written with a scalar — Odoo requires command
        # tuples (e.g. [(6, 0, [ids])]). Every branch below must therefore
        # produce a command list, never a bare id/string, or Odoo raises
        # "Wrong value for <field>: <value>".
        elif field.type == "many2many":
            if isinstance(value, list):
                # Already command tuples (or an id list) — pass through.
                resolved[field_name] = value
            elif isinstance(value, int):
                # Single database ID (e.g. from a /.id mapping).
                resolved[field_name] = [(6, 0, [value])]
            elif isinstance(value, str):
                refs = parse_refs(value)
                if refs and all(r.isdigit() for r in refs):
                    # Numeric database IDs — single "6" or delimited "6|7".
                    # Must be checked BEFORE is_external_id(): a delimited
                    # numeric string like "6|7" is not .isdigit() so it would
                    # otherwise be mistaken for external-id refs and looked up
                    # (and fail as "not found").
                    resolved[field_name] = [(6, 0, [int(r) for r in refs])]
                    if field.comodel_name not in STANDARD_DB_ID_MODELS:
                        warnings.append(
                            f"Field {field_name!r} uses database ID(s) {value}. "
                            f"Consider migrating to external ID for portability."
                        )
                elif is_external_id(value):
                    ids = [lookup_ref(field.comodel_name, ref, ref_map) for ref in refs]
                    resolved[field_name] = [(6, 0, ids)]
                else:
                    resolved[field_name] = value
            else:
                resolved[field_name] = value

        # Boolean fields must be coerced from their raw CSV string before the
        # create/write. Odoo's Boolean.convert_to_column does bool(value), so a
        # raw "0" (a non-empty, therefore truthy, string) would be stored as
        # True. coerce_boolean mirrors ir_fields._str_to_boolean:
        # "0"/"false"/"no" -> False, "1"/"true"/"yes" -> True.
        elif field.type == "boolean":
            resolved[field_name] = coerce_boolean(value)

        # All other fields pass through unchanged
        else:
            resolved[field_name] = value

    return resolved, warnings
