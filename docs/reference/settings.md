# Settings Reference

This section details all available configuration settings in the CSV Import Tool.

## Global Run Settings

These settings apply to the entire import project.

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `batchSize` | 200 | 1-1000 | The number of rows processed in a single Odoo transaction. Larger batches are faster but can fail entirely if one row has a fatal error. In standalone mode, capped to 10-100. |
| `workers` | 1 | 1-4 | Number of parallel threads. Increasing this can drastically improve speed but may cause database locks in Odoo. |
| `retryLimit` | 3 | 0-10 | How many times the tool will attempt to re-process a row that failed due to a transient error (e.g., network timeout). |
| `retryDelayMs` | 500 | 100+ | Milliseconds to wait between retry attempts. |
| `stopOnFatalError` | `false` | `true`/`false` | If true, the entire import process stops immediately when a non-retryable error occurs. |
| `dryRun` | `false` | `true`/`false` | If true, the data is sent to Odoo and validated, but the transactions are rolled back. No data is actually created. |
| `encoding` | `utf-8-sig` | - | CSV file encoding (`utf-8-sig`, `utf-8`, `latin-1`, `cp1252`). Default includes BOM handling. |
| `delimiter` | `,` | - | CSV delimiter character (`,`, `;`, `\t`). Auto-detect supported. |
| `skipHeader` | `true` | `true`/`false` | Whether the first row of the CSV is a header row. |
| `lang` | `de_DE` | - | Odoo language context for the import (affects translated field values). |
| `strict` | `true` | `true`/`false` | If true, the import fails on missing required fields or unresolved references. |

## CSV Parser Settings

Determined per-file during the analysis phase, but can be overridden manually.

| Setting | Description |
|---------|-------------|
| `delimiter` | The character used to separate columns (e.g., `,`, `;`, `\t`). Default: `,`. |
| `encoding` | The character encoding of the file. Default: `utf-8-sig` (UTF-8 with BOM handling). |
| `quoteChar` | The character used to wrap fields containing the delimiter (default is `"`). |
| `escapeChar` | The character used to escape special characters. |

## Odoo Strategy Settings

Defined per-file in the Import view.

| Setting | Description |
|---------|-------------|
| `useExternalId` | If checked, the tool will use the External ID for upsert (Strategy 1). Requires an `id` column or a mapping to `__external_id__`. |
| `searchKeys` | A list of Odoo fields used for Natural Key search (Strategy 2). |
| `strictMode` | If true, the import fails if a required search key is missing or if no match is found for an update. |
