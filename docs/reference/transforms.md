# Field Transforms & Header Patterns

Transforms define how data from a CSV column is modified before being sent to Odoo.

## Available Transforms

| Transform | Description | Example Input | Odoo Value |
|-----------|-------------|---------------|------------|
| `passthrough` | No change. | `John` | `John` |
| `m2o_ref` | Resolves External ID to a Many2One ID. | `base.res_partner_1` | `1` |
| `m2m_ref` | Resolves pipe-separated External IDs to Many2Many commands. | `tag1\|tag2` | `[(6, 0, [10, 11])]` |
| `db_id` | Validates an integer ID for standard models. | `57` | `57` |

### `m2o_ref` (Many2One Reference)
Used for fields like `partner_id`, `category_id`.
*   **Target Model**: You must specify the model of the related record.
*   **Resolution**: If the input is `my_module.my_id`, the tool queries `ir.model.data` for that ID. If no module is provided (`my_id`), it defaults to the `__import__` module.

### `m2m_ref` (Many2Many Reference)
Used for fields like `tag_ids`, `category_ids`.
*   **Input Format**: A string of External IDs separated by a pipe `|`.
*   **Action**: Replaces all existing relations with the ones provided in the CSV.

### `db_id` (Database ID)
Used for fields referencing stable Odoo data.
*   **Allowed Models**: Restricted to `res.country`, `res.currency`, `uom.uom`, `res.lang`, `res.country.state`, `res.partner.title`.
*   **Validation**: The tool verifies the ID exists in Odoo before attempting the import.

## Automatic Header Patterns

If your CSV headers follow these naming conventions, the tool will automatically select the correct field and transform.

| Header Pattern | Detected Transform | Example |
|----------------|--------------------|---------|
| `field/id` | `m2o_ref` or `m2m_ref` | `partner_id/id` |
| `field/.id` | `db_id` | `country_id/.id` |
| `id` | Map to `__external_id__` | `id` |
| `.id` | Map to `id` (database ID) | `.id` |

### External ID Normalization
The tool automatically handles External ID formatting:
*   `base.main_company` -> Stays as is.
*   `main_company` -> Becomes `__import__.main_company`.
*   `123` (numeric string) -> Treated as a Database ID, NOT an External ID.
