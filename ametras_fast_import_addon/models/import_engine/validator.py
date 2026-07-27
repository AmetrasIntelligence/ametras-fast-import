"""
Post-import validation: read records back and check the DB actually holds what
the import intended to write.

An import can report "success" while the stored record diverges from the file —
Odoo may silently coerce a value, a computed/inverse field may override a write,
a domain/access rule may drop it (IHX-9177 is exactly this class of bug). This
module compares the *intended* resolved value (what resolve_row produced) against
the *stored* value read back from the database, field by field.

Strategy: re-derive. Validation re-runs the same transform -> resolve -> record
lookup the import used (no writes), then batch-reads the target records and
compares. Rows that were pure CREATEs with no stable key (no external id, no
search key, no /.id) cannot be located afterwards and are reported as
*unvalidatable* — never silently skipped.

Pure Python — no odoo imports (must run in the standalone Electron subprocess
over XML-RPC). The Importer.validate_rows() method drives it; this module holds
the comparison logic and the report shapes so they can be unit-tested in
isolation.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .coercion import coerce_boolean

__all__ = [
    "ValidationMismatch",
    "ValidationReport",
    "is_empty",
    "values_match",
]

# Kinds of mismatch, most-to-least severe.
KIND_DROPPED = "dropped"  # intended a value, DB stored empty — the IHX-9177 shape
KIND_CHANGED = "changed"  # DB stored something else than intended
KIND_MISSING = "missing"  # the record itself is gone


def is_empty(value: Any) -> bool:
    """Odoo's notion of an 'empty' field value across types."""
    return value in (None, False, "", (), [], {})


def _m2m_intended_ids(value: Any) -> list[int]:
    """Extract the id list from a resolved x2many value.

    resolve_row emits x2many as ``[(6, 0, [ids])]``; also tolerate a bare id
    list for safety.
    """
    if not value:
        return []
    if isinstance(value, (list, tuple)):
        # command form [(6, 0, [ids]), ...]
        ids: list[int] = []
        commands = False
        for item in value:
            if isinstance(item, (list, tuple)) and len(item) == 3 and item[0] == 6:
                commands = True
                ids.extend(int(x) for x in (item[2] or []))
        if commands:
            return ids
        # bare id list
        try:
            return [int(x) for x in value]
        except (TypeError, ValueError):
            return []
    return []


def _m2o_stored_id(stored: Any) -> int | None:
    """search_read returns a many2one as ``[id, display_name]`` (or False)."""
    if isinstance(stored, (list, tuple)):
        return int(stored[0]) if stored else None
    if isinstance(stored, bool):
        return None
    if stored is None:
        return None
    try:
        return int(stored)
    except (TypeError, ValueError):
        return None


def values_match(field_type: str, intended: Any, stored: Any) -> bool:
    """Type-aware equality between an intended write value and a stored value.

    Deliberately lenient about *representation* (Odoo coerces "5" -> 5, name ->
    id, "0" -> False on write) but strict about *loss*: an intended non-empty
    value against an empty stored value is always a mismatch — that is the
    silent-drop this whole feature exists to catch.
    """
    if is_empty(intended) and is_empty(stored):
        return True

    if field_type == "many2one":
        sid = _m2o_stored_id(stored)
        try:
            return int(intended) == sid
        except (TypeError, ValueError):
            return intended == sid

    if field_type in ("many2many", "one2many"):
        return set(_m2m_intended_ids(intended)) == set(int(x) for x in (stored or []))

    if field_type == "boolean":
        try:
            return coerce_boolean(intended) == bool(stored)
        except ValueError:
            return False

    if field_type == "integer":
        try:
            return int(intended) == int(stored or 0)
        except (TypeError, ValueError):
            return str(intended) == str(stored)

    if field_type in ("float", "monetary"):
        try:
            return abs(float(intended) - float(stored or 0.0)) < 1e-6
        except (TypeError, ValueError):
            return str(intended) == str(stored)

    if field_type in ("date", "datetime"):
        # Odoo may widen a date to a datetime ("2026-07-23" ->
        # "2026-07-23 00:00:00"); accept a leading-substring match either way.
        si = str(intended).strip()
        ss = str(stored or "").strip()
        return si == ss or ss.startswith(si) or si.startswith(ss)

    # char / text / html / selection / reference / other scalars.
    left = str(intended)
    right = "" if stored in (None, False) else str(stored)
    return left == right


@dataclass
class ValidationMismatch:
    row_index: int
    record_id: int
    field_name: str
    intended: Any
    stored: Any
    kind: str = KIND_CHANGED

    def to_dict(self) -> dict:
        return {
            "rowNumber": self.row_index,
            "recordId": self.record_id,
            "field": self.field_name,
            "intended": _jsonable(self.intended),
            "stored": _jsonable(self.stored),
            "kind": self.kind,
        }


def _jsonable(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


@dataclass
class ValidationReport:
    model: str = ""
    checked: int = 0  # rows read back and compared
    ok: int = 0  # rows whose every written field matched
    mismatches: list[ValidationMismatch] = field(default_factory=list)
    # (row_index, reason) — rows we could not locate/re-derive (e.g. pure create)
    unvalidatable: list[tuple[int, str]] = field(default_factory=list)

    @property
    def failed(self) -> bool:
        return bool(self.mismatches)

    def merge(self, other: "ValidationReport") -> None:
        self.checked += other.checked
        self.ok += other.ok
        self.mismatches.extend(other.mismatches)
        self.unvalidatable.extend(other.unvalidatable)

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "checked": self.checked,
            "ok": self.ok,
            "failedRows": len({m.row_index for m in self.mismatches}),
            "mismatches": [m.to_dict() for m in self.mismatches],
            "unvalidatable": [
                {"rowNumber": idx, "reason": reason}
                for idx, reason in self.unvalidatable
            ],
        }
