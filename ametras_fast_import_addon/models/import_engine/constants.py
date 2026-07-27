"""
Shared constants for the import engine.

Centralizes all magic numbers, default values, and configuration
that was previously hardcoded across multiple modules.
"""

# ---------------------------------------------------------------------------
# Batch processing
# ---------------------------------------------------------------------------
DEFAULT_BATCH_SIZE = 200
MIN_BATCH_SIZE = 10
MAX_BATCH_SIZE = 1000
DEFAULT_WORKERS = 4
MIN_WORKERS = 1
# Per-row RPC import is latency-bound, so throughput scales ~linearly with
# workers until the server saturates. Capped at 8 to bound DB lock contention
# (the parallel path has no adaptive backpressure — see importer.py).
MAX_WORKERS = 8

# ---------------------------------------------------------------------------
# Retry / resilience
# ---------------------------------------------------------------------------
DEFAULT_RETRY_LIMIT = 3
DEFAULT_RETRY_DELAY_MS = 500
RPC_TIMEOUT_SECONDS = 120
RPC_MAX_RETRIES = 3
RPC_RETRY_BACKOFF_MULTIPLIER = 2  # seconds per attempt: 2, 4, 6
RPC_RECONNECT_TIMEOUT = 300  # Max seconds to wait for connectivity (5 min)

# ---------------------------------------------------------------------------
# Serialization / deadlock retry (RPC mode)
# ---------------------------------------------------------------------------
# A PostgreSQL serialization failure or deadlock (raised e.g. when parallel
# workers contend on a shared ir.sequence row) surfaces over XML-RPC as a
# Fault. Unlike a timeout, it GUARANTEES the server transaction fully rolled
# back — nothing was committed — so re-sending the exact same create/write is
# duplicate-safe and needs no idempotency guard. We retry it a bounded number
# of times with capped, cancellable backoff. On exhaustion the Fault is
# re-raised so the row is marked failed and the import continues — the retry
# can never hang or run away.
SERIALIZATION_RETRY_MAX_ATTEMPTS = 5  # retries after the first try (=> ≤6 sends)
SERIALIZATION_RETRY_BASE_DELAY = 0.5  # seconds; grows 0.5,1,2,4,8…
SERIALIZATION_RETRY_MAX_DELAY = 8.0  # hard cap per backoff
# Case-insensitive substrings identifying a transient, safe-to-retry DB
# concurrency error (English + German locales + psycopg2 class names).
SERIALIZATION_ERROR_SIGNATURES = (
    "could not serialize access",
    "konnte zugriff nicht serialisieren",
    "serializationfailure",
    "deadlock detected",
    "verklemmung",  # German "deadlock" (Verklemmung erkannt)
    "deadlockdetected",
    "transactionrollbackerror",
    "concurrent update",
)

# ---------------------------------------------------------------------------
# CSV parsing
# ---------------------------------------------------------------------------
DELIMITER_DETECTION_SAMPLE_SIZE = 4096  # bytes to read for delimiter detection
FILE_ANALYSIS_SAMPLE_SIZE = 65536  # bytes to read for file analysis (64KB)
DEFAULT_DELIMITER = ","
DEFAULT_ENCODING = "utf-8"
SUPPORTED_DELIMITERS = {";", ",", "\t"}
SAMPLE_ROW_COUNT = 5  # number of sample rows for analysis/preview

# ---------------------------------------------------------------------------
# Special field names (CSV → Odoo mapping conventions)
# ---------------------------------------------------------------------------
FIELD_EXTERNAL_ID = "__external_id__"
FIELD_OPERATION = "__op__"
FIELD_ID = "id"
FIELD_DB_ID = ".id"
SUFFIX_DB_ID = "/.id"
SUFFIX_EXTERNAL_ID = "/id"

# ---------------------------------------------------------------------------
# Operations (for __op__ column)
# ---------------------------------------------------------------------------
OP_CREATE = "create"
OP_UPDATE = "update"
OP_SKIP = "skip"
VALID_OPERATIONS = {OP_CREATE, OP_UPDATE, OP_SKIP}

# ---------------------------------------------------------------------------
# Strategy names (for result reporting)
# ---------------------------------------------------------------------------
STRATEGY_EXTERNAL_ID = "external_id"
STRATEGY_SEARCH_KEYS = "search_keys"
STRATEGY_DB_ID = "db_id"
STRATEGY_CREATE = "create"
STRATEGY_EXPLICIT_OP = "explicit_op"

# ---------------------------------------------------------------------------
# Import default module for external IDs without module prefix
# ---------------------------------------------------------------------------
DEFAULT_IMPORT_MODULE = "__import__"

# ---------------------------------------------------------------------------
# Odoo model names used by the engine
# ---------------------------------------------------------------------------
MODEL_IR_MODEL_DATA = "ir.model.data"
MODEL_IR_MODEL = "ir.model"

# ---------------------------------------------------------------------------
# XML-RPC
# ---------------------------------------------------------------------------
XMLRPC_OBJECT_PATH = "/xmlrpc/2/object"
XMLRPC_COMMON_PATH = "/xmlrpc/2/common"

# ---------------------------------------------------------------------------
# Models allowed for raw database ID (/.id) references.
# These are standard Odoo reference data with stable IDs across instances.
# All other models generate a portability warning (but are allowed).
# ---------------------------------------------------------------------------
STANDARD_DB_ID_MODELS = frozenset(
    {
        "res.country",
        "res.currency",
        "uom.uom",
        "res.lang",
        "res.country.state",
        "res.partner.title",
    }
)

# ---------------------------------------------------------------------------
# Import call context
# ---------------------------------------------------------------------------
# Context applied to every create/write during an import. It disables the
# mail.thread side-effects that a bulk import must not trigger: follower
# auto-subscription, creation/tracking log messages, and field tracking.
#
# Without this, creating a record runs full mail.thread machinery. On stacks
# with custom create() overrides that also subscribe a partner (e.g. the
# creator/responsible), the same follower can be added twice in one create and
# hit the mail_followers unique constraint
# (res_model, res_id, partner_id) -> "a partner cannot follow the same object
# twice". It also avoids spamming chatter and is a significant speed-up.
#
# This mirrors the context Odoo's own base_import / data loading use.
IMPORT_CALL_CONTEXT = {
    "tracking_disable": True,
    "mail_create_nosubscribe": True,
    "mail_create_nolog": True,
    "mail_notrack": True,  # older Odoo alias for tracking_disable; harmless
}

# ---------------------------------------------------------------------------
# Adaptive batch sizing (BatchSizeAdapter)
# ---------------------------------------------------------------------------
BATCH_SIZE_SUCCESS_THRESHOLD = 30  # rows before stepping up
BATCH_SIZE_FAILURE_THRESHOLD = 3  # consecutive failures before stepping down
STANDALONE_POST_TIMEOUT_SUCCESS_THRESHOLD = 300  # elevated threshold after timeout

# ---------------------------------------------------------------------------
# Timeout retry budget (standalone / RPC mode only)
# ---------------------------------------------------------------------------
STANDALONE_TIMEOUT_RETRY_BUDGET_SECONDS = 1800  # 30 minutes
TIMEOUT_RETRY_BASE_DELAY = 1.0  # seconds base backoff
TIMEOUT_RETRY_MAX_DELAY = 30.0  # seconds cap

# ---------------------------------------------------------------------------
# Server-side import job
# ---------------------------------------------------------------------------
PROGRESS_COMMIT_INTERVAL = 10  # seconds between periodic DB commits during import
PAUSE_POLL_INTERVAL_SECONDS = 2  # seconds between pause-flag polls
STALE_JOB_CUTOFF_HOURS = 2  # hours without heartbeat before marking as interrupted
MAX_POLL_ERROR_ENTRIES = 500  # errors stored per live-poll write (~100 KB)
MAX_FINAL_ERROR_ENTRIES = (
    5_000  # errors stored in final write (for history/CSV download)
)

# ---------------------------------------------------------------------------
# Progress reporting (JSON lines protocol types)
# ---------------------------------------------------------------------------
PROGRESS_TYPE_FILE_START = "file_start"
PROGRESS_TYPE_PROGRESS = "progress"
PROGRESS_TYPE_FILE_DONE = "file_done"
PROGRESS_TYPE_DONE = "done"
PROGRESS_TYPE_ERROR = "error"
PROGRESS_TYPE_ANALYSIS = "analysis"
PROGRESS_TYPE_PONG = "pong"
PROGRESS_TYPE_AUTH_OK = "auth_ok"
PROGRESS_TYPE_MODELS = "models"
PROGRESS_TYPE_FIELDS = "fields"
PROGRESS_TYPE_CANCELLED = "cancelled"
PROGRESS_TYPE_VALIDATION = "validation"
PROGRESS_TYPE_BATCH_ERRORS = "batch_errors"
PROGRESS_TYPE_CONNECTION_LOST = "connection_lost"
PROGRESS_TYPE_CONNECTION_RESTORED = "connection_restored"
PROGRESS_TYPE_NOTICE = "notice"

# Notice event codes (carried in the "code" field of a notice message).
# Surfaced to the user so resilience operations are visible, not silent.
NOTICE_BATCH_SHRUNK = "batch_shrunk"
NOTICE_UNSAFE_ROWS_SKIPPED = "unsafe_rows_skipped"
NOTICE_RETRY_BUDGET_EXHAUSTED = "retry_budget_exhausted"
NOTICE_WAITING_FOR_RETRY = "waiting_for_retry"
NOTICE_SAFE_RETRY_TIMED_OUT = "safe_retry_timed_out"
# Operational visibility notices (not resilience actions, just observability).
NOTICE_IMPORT_CONFIG = "import_config"  # concurrency / batch size / timeouts at start
NOTICE_RPC_RETRY = "rpc_retry"  # a single RPC call is being retried
NOTICE_RPC_TIMEOUT = "rpc_timeout"  # a single RPC call timed out (then retried)
NOTICE_SERIALIZATION_RETRY = "serialization_retry"  # DB serialization/deadlock retry

# Protocol version — bumped when a breaking change is made to the JSON-lines
# protocol. Electron can use this to refuse incompatible engine versions.
PROTOCOL_VERSION = 1

# ---------------------------------------------------------------------------
# Subprocess (Electron) response error caps
# ---------------------------------------------------------------------------
# Raw-rows mode (single in-memory batch): allow up to 10k errors before truncating.
MAX_RESPONSE_ERRORS_BATCH_MODE = 10_000
# File mode (streaming): cap at 500 to prevent stdout overflow on large imports.
MAX_RESPONSE_ERRORS_FILE_MODE = 500
