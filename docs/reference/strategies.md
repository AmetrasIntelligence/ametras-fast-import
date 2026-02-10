# Import Strategies

The CSV Import Tool supports multiple strategies for identifying whether to create a new record or update an existing one in Odoo.

## Strategy 1: External ID (Upsert)

This is the **preferred and most robust strategy**. It uses Odoo's `ir.model.data` (External IDs) to identify records.

*   **Logic**:
    1.  The tool checks if the record has an External ID (either from an `id` column or a mapping).
    2.  If the External ID exists in Odoo for that model, the record is **updated**.
    3.  If it does not exist, a new record is **created**, and the External ID is assigned to it.
*   **Benefits**:
    *   Imports are idempotent (can be run multiple times safely).
    *   Links between records remain stable across different Odoo instances.
    *   Works even if natural keys (like names) change.

## Strategy 2: Natural Key (Search)

Use this when you don't have External IDs but have unique identifiers like a SKU, Email, or Internal Reference.

*   **Logic**:
    1.  You define one or more fields as "Search Keys" in the configuration.
    2.  Odoo searches for an existing record where all Search Keys match the CSV data.
    3.  If exactly one match is found, the record is **updated**.
    4.  If no match is found, a new record is **created**.
    5.  If multiple matches are found, a warning is logged, and usually, the first one is updated (depending on server settings).
*   **Requirements**: The fields used as search keys should have a unique constraint or index in Odoo for optimal performance.

## Strategy 3: Database ID

Use this only for same-database operations or when importing stable reference data.

*   **Logic**: Matches records directly by their integer Database ID (`id`).
*   **Constraint**: For security and data integrity, the tool restricts raw Database ID lookups to a set of "Standard Reference Models" by default (e.g., `res.country`, `res.currency`, `uom.uom`).

## Strategy 4: Explicit Operation (`__op__`)

You can control the operation per-row by adding a special column `__op__` to your CSV.

| Value | Action |
|-------|--------|
| `create` | Always attempts to create a new record. Fails if an External ID is provided and already exists. |
| `update` | Attempts to find and update a record. Fails if the record is not found. |
| `skip`   | The row is ignored by the importer. |

## One2Many Handling (Flat Mode)

One2Many fields (like order lines or bank accounts) are **NOT** imported inline within the parent record's CSV. Instead, the tool uses a flat structure with parent-child references.

### Recommended Pattern:
1.  **Parent File**: Create parent records (e.g., Partners) with External IDs.
2.  **Child File**: Create child records (e.g., Bank Accounts) and reference the parent via a Many2One field using the parent's External ID.
3.  **Sequence**: Ensure the Parent file is imported before the Child file by using the **Sequence & Dependencies** feature in the Import Profile.

## Strategy Priority

When multiple identifiers are present, Odoo follows this priority:
1.  **Explicit Operation** (if `__op__` is present).
2.  **External ID** (if present and `use_external_id` is enabled).
3.  **Natural Key** (if Search Keys are configured).
4.  **Database ID** (if present).
5.  **Create** (fallback).
