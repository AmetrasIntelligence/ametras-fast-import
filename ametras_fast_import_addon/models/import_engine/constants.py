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
MAX_WORKERS = 4

# ---------------------------------------------------------------------------
# Retry / resilience
# ---------------------------------------------------------------------------
DEFAULT_RETRY_LIMIT = 3
DEFAULT_RETRY_DELAY_MS = 500
RPC_TIMEOUT_SECONDS = 120
RPC_MAX_RETRIES = 3
RPC_RETRY_BACKOFF_MULTIPLIER = 2  # seconds per attempt: 2, 4, 6

# ---------------------------------------------------------------------------
# CSV parsing
# ---------------------------------------------------------------------------
DELIMITER_DETECTION_SAMPLE_SIZE = 4096  # bytes to read for delimiter detection
FILE_ANALYSIS_SAMPLE_SIZE = 65536  # bytes to read for file analysis (64KB)
DEFAULT_DELIMITER = ','
DEFAULT_ENCODING = 'utf-8'
SUPPORTED_DELIMITERS = {';', ',', '\t'}
SAMPLE_ROW_COUNT = 5  # number of sample rows for analysis/preview

# ---------------------------------------------------------------------------
# Special field names (CSV → Odoo mapping conventions)
# ---------------------------------------------------------------------------
FIELD_EXTERNAL_ID = '__external_id__'
FIELD_OPERATION = '__op__'
FIELD_ID = 'id'
FIELD_DB_ID = '.id'
SUFFIX_DB_ID = '/.id'
SUFFIX_EXTERNAL_ID = '/id'

# ---------------------------------------------------------------------------
# Operations (for __op__ column)
# ---------------------------------------------------------------------------
OP_CREATE = 'create'
OP_UPDATE = 'update'
OP_SKIP = 'skip'
VALID_OPERATIONS = {OP_CREATE, OP_UPDATE, OP_SKIP}

# ---------------------------------------------------------------------------
# Strategy names (for result reporting)
# ---------------------------------------------------------------------------
STRATEGY_EXTERNAL_ID = 'external_id'
STRATEGY_SEARCH_KEYS = 'search_keys'
STRATEGY_DB_ID = 'db_id'
STRATEGY_CREATE = 'create'
STRATEGY_EXPLICIT_OP = 'explicit_op'

# ---------------------------------------------------------------------------
# Import default module for external IDs without module prefix
# ---------------------------------------------------------------------------
DEFAULT_IMPORT_MODULE = '__import__'

# ---------------------------------------------------------------------------
# Odoo model names used by the engine
# ---------------------------------------------------------------------------
MODEL_IR_MODEL_DATA = 'ir.model.data'
MODEL_IR_MODEL = 'ir.model'

# ---------------------------------------------------------------------------
# XML-RPC
# ---------------------------------------------------------------------------
XMLRPC_OBJECT_PATH = '/xmlrpc/2/object'
XMLRPC_COMMON_PATH = '/xmlrpc/2/common'

# ---------------------------------------------------------------------------
# Models allowed for raw database ID (/.id) references.
# These are standard Odoo reference data with stable IDs across instances.
# All other models generate a portability warning (but are allowed).
# ---------------------------------------------------------------------------
STANDARD_DB_ID_MODELS = frozenset({
    'res.country',
    'res.currency',
    'uom.uom',
    'res.lang',
    'res.country.state',
    'res.partner.title',
})

# ---------------------------------------------------------------------------
# Progress reporting (JSON lines protocol types)
# ---------------------------------------------------------------------------
PROGRESS_TYPE_FILE_START = 'file_start'
PROGRESS_TYPE_PROGRESS = 'progress'
PROGRESS_TYPE_FILE_DONE = 'file_done'
PROGRESS_TYPE_DONE = 'done'
PROGRESS_TYPE_ERROR = 'error'
PROGRESS_TYPE_ANALYSIS = 'analysis'
PROGRESS_TYPE_PONG = 'pong'
PROGRESS_TYPE_AUTH_OK = 'auth_ok'
PROGRESS_TYPE_MODELS = 'models'
PROGRESS_TYPE_FIELDS = 'fields'
PROGRESS_TYPE_CANCELLED = 'cancelled'
