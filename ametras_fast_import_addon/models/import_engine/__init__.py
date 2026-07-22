# Pure Python import engine — no odoo imports allowed in this package.
# Works standalone (Electron subprocess) or inside Odoo (via OrmBackend).

from .backend import OdooBackend, RpcBackend, FieldInfo, TransportError
from .batch_size_adapter import BatchSizeAdapter
from .idempotency import assess_timeout_retry_idempotency, IdempotencyResult
from .constants import (
    DEFAULT_BATCH_SIZE,
    MIN_BATCH_SIZE,
    MAX_BATCH_SIZE,
    DEFAULT_WORKERS,
    MIN_WORKERS,
    MAX_WORKERS,
    STANDARD_DB_ID_MODELS,
)
from .coercion import coerce_boolean, coerce_selection
from .transformer import transform_row_data
from .resolver import (
    is_external_id,
    parse_refs,
    normalize_ext_id,
    lookup_ref,
    resolve_relation_ref,
    prefetch_references,
    resolve_row,
)
from .parser import (
    ParsedRow,
    ParseOptions,
    parse_csv_file,
    parse_csv_batched,
    parse_csv_string,
    analyze_csv,
    analyze_csv_file,
    count_csv_rows,
    extract_rows_by_index,
)
from .importer import Importer, ImportConfig, RowResult
from .progress import ProgressReporter, NullReporter, JsonLinesReporter
