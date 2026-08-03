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

from .coercion import coerce_boolean, coerce_selection
from .constants import (
    DEFAULT_IMPORT_MODULE,
    FIELD_EXTERNAL_ID,
    FIELD_ID,
    FIELD_OPERATION,
    MODEL_IR_MODEL_DATA,
    STANDARD_DB_ID_MODELS,
)

_logger = logging.getLogger(__name__)

# Sentinel key under which resolve_relation_ref caches name_search results
# inside a ref_map. A ref_map lives for one batch, so each distinct display
# name is looked up at most once per batch.
_NAME_CACHE = "__name_cache__"

# Re-export for backward compatibility
__all__ = [
    "STANDARD_DB_ID_MODELS",
    "coerce_boolean",
    "coerce_selection",
    "is_external_id",
    "parse_refs",
    "normalize_ext_id",
    "lookup_ref",
    "resolve_relation_ref",
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


def resolve_relation_ref(backend: Any, comodel: str, value: str, ref_map: dict) -> int:
    """
    Resolve a relational reference (as a string) to a database id.

    Tries the external id (xml_id) first via the prefetched ``ref_map``; on a
    miss, falls back to ``name_search`` on the target model — so a CSV can
    reference a relation by external id OR by display name, matching Odoo's
    own import (model.load -> db_id_for). name_search results are cached in
    ``ref_map`` for the life of the batch.

    Raises ValueError if the reference resolves to neither an external id nor a
    unique record name (ambiguous or missing).
    """
    module, name = normalize_ext_id(value)
    xml_key = (comodel, module, name)
    if xml_key in ref_map:
        return ref_map[xml_key]

    cache = ref_map.setdefault(_NAME_CACHE, {})
    cache_key = (comodel, value)
    if cache_key in cache:
        cached = cache[cache_key]
        if cached is None:
            raise ValueError(
                f"{value!r} not found for model {comodel} "
                f"(no external id and no record of that name)"
            )
        return cached

    matches = backend.name_search(comodel, value) or []
    ids = [m[0] if isinstance(m, (list, tuple)) else m for m in matches]
    if len(ids) == 1:
        cache[cache_key] = ids[0]
        return ids[0]

    cache[cache_key] = None
    if not ids:
        raise ValueError(
            f"{value!r} not found for model {comodel} "
            f"(no external id and no record of that name)"
        )
    raise ValueError(
        f"{value!r} is ambiguous for model {comodel}: "
        f"matches multiple records by name"
    )


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
            # An integral float (272.0) is the same db id as the int 272 — the
            # JSON `raw_rows` API delivers typed numbers, and a spreadsheet cell
            # often arrives as a float. Normalise it to int so it takes the
            # db-id path below instead of falling to the raw passthrough, where
            # Many2one.convert_to_cache would silently NULL it (float is not in
            # IdType) — the exact IHX-9177 failure mode for a different type.
            if isinstance(value, float) and value.is_integer():
                value = int(value)

            # bool is a subclass of int but is never a valid m2o reference.
            if isinstance(value, bool):
                raise ValueError(
                    f"Field {field_name!r} got a boolean {value!r}; "
                    f"expected a record reference (id, external id, or name)"
                )
            if isinstance(value, int):
                # Integer value = database ID (from a /.id mapping, or a cell
                # already coerced server-side). Accept for all models — the
                # user explicitly opted in by using the /.id suffix.
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
            elif isinstance(value, str):
                # Any non-empty string is a reference to resolve: external id
                # first (via the prefetched ref_map), then a name_search
                # fallback on the comodel. This deliberately includes ALL-DIGIT
                # strings such as a manufacturer *number* ("272") — mirroring
                # Odoo's model.load (ir_fields.db_id_for with subfield=None),
                # which always name_searches a bare relational value and raises
                # a visible error when it cannot resolve.
                #
                # We must NEVER hand an unresolved scalar to a many2one:
                # Many2one.convert_to_cache silently coerces any non-id value to
                # NULL (odoo/fields.py; IdType == (int, NewId)) and
                # convert_to_column is `value or None`, so the reference would
                # vanish with no error and the row would still import — WITHOUT
                # the link. That is IHX-9177: products created without a
                # Hersteller because "272" fell through the old passthrough.
                # resolve_relation_ref raises instead, so the row fails loudly
                # and surfaces in the import log / "retry failed".
                #
                # A genuine numeric DB id must be supplied via the `/.id`
                # mapping (arrives as an int, handled above) — NOT as a bare
                # numeric string, otherwise a coincidental id collision could
                # link the wrong record silently.
                resolved[field_name] = resolve_relation_ref(
                    backend, field.comodel_name, value, ref_map
                )
            else:
                # Any other type (non-integral float, list, etc.) is not a valid
                # many2one reference. Raise instead of passing it through: Odoo
                # would silently coerce it to NULL (see the string branch), so a
                # loud per-row error is the only way the caller learns the link
                # was not set.
                raise ValueError(
                    f"Field {field_name!r} got {type(value).__name__} "
                    f"{value!r}; expected a record reference "
                    f"(id, external id, or name)"
                )

        # Many2Many field resolution.
        #
        # x2many fields cannot be written with a scalar — Odoo requires command
        # tuples (e.g. [(6, 0, [ids])]). Every branch below must therefore
        # produce a command list, never a bare id/string, or Odoo raises
        # "Wrong value for <field>: <value>".
        elif field.type == "many2many":
            if isinstance(value, list):
                # A bare list of database ids (e.g. from a delimited /.id
                # mapping like "173,213") must be wrapped in a replace command;
                # a list already made of Odoo command tuples passes through.
                if value and all(
                    isinstance(v, int) and not isinstance(v, bool) for v in value
                ):
                    resolved[field_name] = [(6, 0, value)]
                else:
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
                    ids = [
                        resolve_relation_ref(backend, field.comodel_name, ref, ref_map)
                        for ref in refs
                    ]
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

        # Selection fields: translate a human label to its stored key (Odoo
        # stores the key and would reject the label). A value that is already a
        # key, or is neither key nor label, is passed through unchanged.
        elif field.type == "selection":
            resolved[field_name] = coerce_selection(value, field.selection)

        # All other fields pass through unchanged
        else:
            resolved[field_name] = value

    return resolved, warnings
