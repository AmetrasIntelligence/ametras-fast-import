# Import Settings

## Run Settings

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `batchSize` | 200 | 1-1000 (addon), 10-100 (standalone) | Rows per Odoo transaction. Larger = faster but a single bad row fails the batch. Auto-clamped in standalone mode. |
| `workers` | 1 | 1-4 (addon), 1-3 (standalone) | Parallel workers. Standalone uses concurrency retry with backoff to handle transient database locks. |
| `retryLimit` | 3 | 0-10 | Retry attempts for transient errors (network timeouts, locks). |
| `retryDelayMs` | 500 | 100+ | Milliseconds between retry attempts. |
| `stopOnFatalError` | `false` | — | Stop the entire import on a non-retryable error. |
| `dryRun` | `false` | — | Validate data without writing. Addon mode only. |
| `encoding` | `utf-8-sig` | — | CSV encoding: `utf-8-sig`, `utf-8`, `latin-1`, `cp1252`. |
| `delimiter` | `,` | — | CSV delimiter: `,`, `;`, `\t`, or auto-detect. |
| `lang` | `de_DE` | — | Odoo language context for translated field values. Addon mode only. |
| `strict` | `true` | — | Fail on missing required fields or unresolved references. |

## CSV Parser Settings

Determined per-file during analysis, overridable manually:

| Setting | Description |
|---------|-------------|
| `delimiter` | Column separator (`,`, `;`, `\t`). Auto-detected. |
| `encoding` | File encoding. Auto-detected with BOM handling. |
| `quoteChar` | Field wrapper character (default `"`). |
| `escapeChar` | Escape character for special characters. |

## Standalone Mode Constraints

When the `ametras_fast_import` addon is not installed, the client operates in standalone mode with these constraints:

- **Batch size**: 10-100 (auto-clamped from global default)
- **Workers**: Up to 3 (concurrency errors are retried with exponential backoff + jitter)
- **No dry run**: `model.load()` does not support validation-only mode
- **No language context**: Language setting is not available
- **Adaptive batch sizing**: Starts at size 1, ramps up through 1 → 10 → max after proving data quality (100 consecutive successful rows to step up, 3 consecutive failures to step down)
