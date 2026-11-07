"""
Batched writes.

New records are created with one ``create()`` call per batch: the same
``create()`` the row-by-row import calls, with a list of values, so every
model behaves as before.

Updates go through Odoo's ``load()`` for the models in BATCH_UPDATE_MODELS
only. ``load()`` runs model hooks (``_load_records_create`` /
``_load_records_write``) that some models override with behaviour of their own
(``stock.quant`` switches to inventory mode, ``project.task`` handles
recurrences, ``ir.ui.view`` copies views): those models stay row by row. On
the listed models, ``load()`` writes an update with ``write()`` in a context
with ``install_mode``; no write of these models in Odoo, OCA or Ametras
modules reads it (it only changes how html/xml translations are matched).

The engine resolves every row itself (references, booleans, selections,
readonly rules) exactly as for a row-by-row import. This module only turns
those already-resolved values into the text cells ``load()`` expects, in a
form ``load()`` cannot read differently:

- many2one: the database id in a ``<field>/.id`` column
- many2many: a replace command becomes ``<field>/.id`` with comma-separated ids
- boolean: ``1`` / ``0``
- numbers: Python's own text form (``float()`` / ``int()`` read it back)
- text, dates and selection keys: unchanged

A value that has no such form (one2many, binary, reference, datetime, a
command list other than replace, ``False`` on a non-boolean field, a field the
model does not have) raises :class:`NotBatchable`; the importer then writes
that row the row-by-row way, so it behaves exactly as before.
"""
from __future__ import annotations

import datetime
from typing import Any

from .backend import FieldInfo
from .constants import IMPORT_CALL_CONTEXT, SERIALIZATION_ERROR_SIGNATURES

# Models whose updates go through load(). Their load() update is a plain
# write() (no _load_records_write override in Odoo, OCA or Ametras modules).
BATCH_UPDATE_MODELS = frozenset(
    {
        "product.template",
        "product.product",
        "product.supplierinfo",
        "product.pricelist.item",
        "res.partner",
    }
)

# Search key types whose values one bulk read compares exactly as the
# server's "=" does. Other key types are searched row by row.
BULK_SEARCH_KEY_TYPES = frozenset({"char", "text", "selection", "many2one"})

# Context for load() calls: the import context of create/write.
LOAD_CONTEXT = dict(IMPORT_CALL_CONTEXT)

# Lookup result for a row the bulk reads cannot answer exactly like the
# row-by-row lookup: the row is written row by row.
ROW_BY_ROW = object()

# Field types whose values load() cannot take from a resolved value. Datetimes
# are left out because load() reads them in the user's time zone, while
# write() stores the engine's text as UTC.
_NOT_BATCHABLE_TYPES = frozenset(
    {
        "one2many",
        "binary",
        "reference",
        "properties",
        "properties_definition",
        "json",
        "datetime",
    }
)


class NotBatchable(ValueError):
    """The row holds a value that only the row-by-row write can store as is."""


def load_cell(info: FieldInfo | None, field_name: str, value: Any) -> tuple[str, str]:
    """Return (column, text) for one resolved value."""
    if info is None:
        raise NotBatchable(f"{field_name!r} is not a field of the model")
    ftype = info.type
    if ftype in _NOT_BATCHABLE_TYPES:
        raise NotBatchable(f"{field_name!r} is a {ftype} field")
    if ftype == "boolean":
        return field_name, "1" if value else "0"
    if ftype == "many2one":
        if isinstance(value, int) and not isinstance(value, bool):
            return f"{field_name}/.id", str(value)
        raise NotBatchable(f"{field_name!r} holds {value!r}, not a record id")
    if ftype == "many2many":
        ids = _replace_command_ids(value)
        if ids is None:
            raise NotBatchable(f"{field_name!r} holds commands other than replace")
        return f"{field_name}/.id", ",".join(str(i) for i in ids)
    if ftype == "selection":
        # load() also accepts labels and other letter case; only an exact key
        # is read as the row-by-row write reads it
        keys = {key for key, _label in (info.selection or [])}
        if value not in keys:
            raise NotBatchable(f"{field_name!r} holds {value!r}, not a selection key")
        return field_name, value
    if isinstance(value, bool) or value is None:
        raise NotBatchable(f"{field_name!r} holds {value!r}")
    if isinstance(value, float):
        if ftype == "integer":
            raise NotBatchable(f"{field_name!r} holds the float {value!r}")
        return field_name, repr(value)
    if isinstance(value, int):
        return field_name, str(value)
    if isinstance(value, datetime.date):
        return field_name, value.isoformat()
    if isinstance(value, str):
        return field_name, value
    raise NotBatchable(f"{field_name!r} holds a {type(value).__name__}")


def _replace_command_ids(value: Any) -> list[int] | None:
    """Ids of a single replace command [(6, 0, ids)], else None."""
    if not isinstance(value, (list, tuple)) or len(value) != 1:
        return None
    command = value[0]
    if not isinstance(command, (list, tuple)) or len(command) != 3:
        return None
    if command[0] != 6:
        return None
    ids = command[2]
    if not isinstance(ids, (list, tuple)) or not all(
        isinstance(i, int) and not isinstance(i, bool) for i in ids
    ):
        return None
    return list(ids)


def is_concurrency_message(message: str) -> bool:
    """True for a serialization failure or deadlock reported by load().

    load() catches these inside its own savepoints and returns them as
    messages after rolling the whole call back, so re-sending is safe.
    """
    text = (message or "").lower()
    return any(sig in text for sig in SERIALIZATION_ERROR_SIGNATURES)


def load_errors(result: dict) -> list[str]:
    """Error messages of a load() result (warnings are left out)."""
    return [
        str(m.get("message", ""))
        for m in result.get("messages", [])
        if m.get("type") == "error"
    ]
