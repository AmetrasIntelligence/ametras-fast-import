# Standalone Mode

## Overview

Standalone mode activates when the `ametras_fast_import` addon is not detected on the Odoo server. It uses Odoo's native `model.load()` API via `/web/dataset/call_kw`.

## Features Comparison

| Feature | Addon | Standalone |
|---------|-------|------------|
| Basic CSV import | ✓ | ✓ |
| External ID / Database ID / Relational fields | ✓ | ✓ |
| Parallel workers | Up to 4 | Up to 3 |
| Network resilience & auto-reconnect | ✓ | ✓ |
| Concurrency retry with backoff | N/A (savepoints) | ✓ |
| Adaptive retry (geometric splitting) | N/A | ✓ |
| Adaptive batch sizing (warmup) | N/A | ✓ |
| Local profiles | ✓ | ✓ |
| Server profiles | ✓ | ✗ |
| Search key upsert | ✓ | ✗ |
| Per-row error handling | ✓ | ✗ (batch-level, isolated via splitting) |
| Dry run / row validation | ✓ | ✗ |
| Server-side logs & resume | ✓ | ✗ |
| `__op__` column | ✓ | ✗ |

## Concurrency Retry

With multiple workers, concurrent `model.load()` calls can trigger transient PostgreSQL errors (deadlocks, serialization failures, duplicate key races). These are handled automatically:

1. **Detection**: Error patterns like `deadlock detected`, `could not serialize access`, `duplicate key value violates unique constraint` are classified as `CONCURRENCY_ERROR`.
2. **Retry**: Up to 3 attempts with full-jitter exponential backoff (500ms base, 5s cap).
3. **Fallthrough**: Exhausted retries fall through to adaptive retry (geometric batch splitting).

## Adaptive Retry (Geometric Splitting)

Since `model.load()` is atomic per batch, a single bad row fails the entire batch. Failed batches are split geometrically:

```
100 rows fail → retry in chunks of 10 → retry failed chunks row-by-row
```

Every failing row is individually identified with its Odoo error message.

## Adaptive Batch Sizing

Each file starts at batch size 1 and ramps up: **1 → 10 → maxSize** (capped at 100).
- Step up after 100 consecutive successful rows
- Step down after 3 consecutive failed batches
- Reset per file

## Limitations

- **Batch size**: 10-100 (auto-clamped)
- **Max 3 workers**: More workers increases deadlock probability without proportional throughput
- **No dry run, no language context**
- **No search key upsert**: Use external IDs or database IDs
- **No server profiles**: Use local profiles (can push to server)
- **No server-side logs or resume**: Interrupted imports restart from scratch
- **No `__op__` column**: Create/update determined by ID presence

## API Format

```javascript
POST /web/dataset/call_kw
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model": "product.template",
    "method": "load",
    "args": [
      ["name", "default_code", "categ_id/id"],
      [["Product A", "PROD-001", "product.category_1"]]
    ],
    "kwargs": {}
  }
}
```

## Troubleshooting

- **"Unexpected token '<'"**: Endpoint returning HTML instead of JSON — usually session expired or trying to use addon-only features.
- **All rows failing**: Check for missing required fields, non-existent relational references, or type mismatches. Geometric retry will isolate the specific failing rows.
