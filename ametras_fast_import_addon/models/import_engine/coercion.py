"""
Type-aware scalar coercion for CSV values.

The fast importer builds a ``vals`` dict from raw CSV strings and calls
``create`` / ``write`` directly, bypassing Odoo's import-conversion layer
(``model.load`` -> ``ir_fields._str_to_*``). Odoo then applies the *field's*
``convert_to_column`` rather than the import converter, and for Boolean that is
``bool(value)`` — so the string ``"0"`` becomes ``True`` (a non-empty string is
truthy). This module re-implements the scalar conversions the import layer
would have done, so the value is correctly typed *before* it reaches
create/write.

Pure Python — no odoo imports (must run in the standalone Electron subprocess,
which talks to a vanilla Odoo over XML-RPC with no server addon in the loop).

Handled here: booleans (bool("0") is silently True — the one type Odoo's
convert_to_column mistypes) and selection labels (Odoo stores the *key*, not the
translated label, so a CSV carrying a label would be rejected). Integer / float
/ date / datetime are intentionally NOT coerced: Odoo's convert_to_column types
them correctly server-side (ORM and XML-RPC) or raises a loud per-row error.
"""
from __future__ import annotations

from typing import Any

__all__ = ["coerce_boolean", "coerce_selection"]

# Mirrors odoo/addons/base/models/ir_fields.py::_str_to_boolean.
# Case-insensitive; the empty string maps to False (an unchecked box).
_TRUE_TOKENS = frozenset({"1", "true", "yes"})
_FALSE_TOKENS = frozenset({"", "0", "false", "no"})


def coerce_boolean(value: Any) -> bool:
    """
    Coerce a raw CSV value to a Python ``bool``.

    Mirrors Odoo's import converter (``ir_fields._str_to_boolean``):

    - ``"1"`` / ``"true"`` / ``"yes"`` (any case, surrounding space ok) -> ``True``
    - ``"0"`` / ``"false"`` / ``"no"`` / ``""`` -> ``False``
    - an existing ``bool`` -> returned unchanged
    - an ``int`` / ``float`` -> ``bool(value)`` (0 -> False, non-zero -> True)
    - ``None`` -> ``False`` (an absent value is an unchecked box)
    - anything else -> ``ValueError``

    Raising on an unrecognised token is deliberate: it surfaces a per-row error
    instead of silently guessing (which is how ``bool("0") -> True`` corrupted
    data in the first place). Odoo itself warns and defaults to ``True`` here;
    we prefer a hard, visible failure for the offending row.
    """
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    # NB: bool is a subclass of int, but it is handled above already.
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        token = value.strip().lower()
        if token in _TRUE_TOKENS:
            return True
        if token in _FALSE_TOKENS:
            return False
        raise ValueError(
            f"Unknown value {value!r} for boolean field "
            f"(expected one of 1/0, true/false, yes/no)"
        )
    raise ValueError(f"Cannot coerce {type(value).__name__} value {value!r} to boolean")


def coerce_selection(value: Any, selection: Any) -> Any:
    """
    Map a selection *label* to its stored *key*.

    Odoo stores the selection key (e.g. ``"invoice"``), but a CSV often carries
    the human label (e.g. ``"Invoice Address"``). ``convert_to_column`` validates
    against keys and rejects labels, so we translate label -> key here.

    - value already a valid key -> returned unchanged
    - value matches a label (case-insensitive, trimmed) -> its key
    - no match, or no selection metadata -> returned unchanged (Odoo then
      raises a loud per-row error for a genuinely invalid value)

    ``selection`` is the field's list of ``(key, label)`` pairs (or None).
    """
    if not isinstance(value, str) or not selection:
        return value
    keys = {opt[0] for opt in selection}
    if value in keys:
        return value
    token = value.strip().lower()
    for key, label in selection:
        if isinstance(label, str) and label.strip().lower() == token:
            return key
    return value
