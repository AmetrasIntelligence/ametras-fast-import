# Configuration & Mapping

The **Configure** view is where you define how each CSV file maps to Odoo models and fields.

## Model Assignment

For each CSV file, you must specify the target Odoo model (e.g., `res.partner`, `product.template`).

*   **Smart Suggestions**: The tool automatically suggests models based on the filename. Suggestions are displayed with a confidence score.
*   **Manual Selection**: You can search for any Odoo model by its technical name or display label.
*   **Saved Mappings**: The tool remembers your previous assignments for specific filenames and suggests them the next time you use a file with a similar name.

## Field Mapping

Once a model is selected, click **Map Fields** to open the field mapping interface.

### The Mapping Table

The table shows all CSV headers on the left and their corresponding Odoo fields on the right.

*   **CSV Header**: The literal header from your file.
*   **Odoo Field**: The target field on the model. Use the searchable dropdown to select a field. You can search by technical name (e.g., `phone`) or label (e.g., `Phone`).
*   **Transform**: Specifies how the data should be processed before being sent to Odoo.
*   **Status**: Indicates if the mapping is valid.

### Field Suggestions

The tool uses a scoring engine to automatically map headers to fields. It handles:
*   Exact matches.
*   Similarity (e.g., `Partner` -> `partner_id`).
*   Common aliases (e.g., `Street` -> `street`, `PLZ` -> `zip`).

### Relational Fields (Many2One, Many2Many)

When mapping to a relational field, you must choose a **Transform** to tell the tool how to resolve the reference:

*   **Many2One via External ID (`m2o_ref`)**: Use this when your CSV contains the External ID (xml_id) of the related record. This is the most robust method for data migration.
*   **Many2Many via External IDs (`m2m_ref`)**: Use this for Many2Many fields. The CSV value should be a list of External IDs separated by a pipe (`|`).
*   **Database ID (`db_id`)**: Use this only for stable reference data (e.g., Countries, Currencies). It expects a literal integer ID from the database.

### Smart Reference Detection

If your CSV header ends with `/id` or `/.id`, the tool will automatically suggest the appropriate transform:
*   `header/id` -> Suggests `m2o_ref` or `m2m_ref`.
*   `header/.id` -> Suggests `db_id`.

## Run Settings

Configure the execution parameters for the entire import:

*   **Batch Size**: Number of rows sent to Odoo in a single request. Default is 200. In standalone mode, automatically clamped to a maximum of 100 (range 10-100). Smaller batches are safer; larger batches are faster.
*   **Workers**: Number of parallel processes (1-4). Parallelism can significantly speed up large imports but may cause locking issues in Odoo if the models are highly interconnected.
*   **Retry Limit**: How many times to retry a failed row before giving up.
*   **Retry Delay**: Milliseconds to wait between retries.
*   **Stop on Fatal Error**: If enabled, the entire import stops if an unrecoverable error occurs (e.g., Odoo server goes down).
