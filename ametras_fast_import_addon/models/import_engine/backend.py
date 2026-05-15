"""
Backend abstraction for Odoo operations.

OdooBackend is the abstract interface. Two implementations:
- RpcBackend: XML-RPC to any vanilla Odoo (no addon needed). Lives here.
- OrmBackend: Direct ORM access inside Odoo. Lives in models/orm_backend.py.
"""
from __future__ import annotations

import logging
import socket
import ssl
import threading
import time as _time
import xmlrpc.client
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Optional

from .constants import (
    RPC_TIMEOUT_SECONDS, RPC_MAX_RETRIES, RPC_RETRY_BACKOFF_MULTIPLIER,
    RPC_RECONNECT_TIMEOUT,
    XMLRPC_OBJECT_PATH, XMLRPC_COMMON_PATH,
)
from .progress import ProgressReporter, NullReporter

_logger = logging.getLogger(__name__)


class TransportError(RuntimeError):
    """
    Raised by RpcBackend when a network/protocol failure exhausted all quick
    retries and the reconnect budget.  Distinct from Odoo application errors
    (ValueError) so callers can decide whether to retry the batch.
    """


@dataclass
class FieldInfo:
    """Minimal field metadata needed by the import engine."""
    name: str
    type: str  # 'many2one', 'many2many', 'char', 'integer', etc.
    comodel_name: str = ''  # Target model for relational fields


class _NullSavepoint:
    """No-op savepoint for backends that don't support transactions."""

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def rollback(self):
        pass


class OdooBackend(ABC):
    """Abstract interface for Odoo operations."""

    @abstractmethod
    def search(self, model: str, domain: list,
               fields: Optional[list] = None,
               limit: Optional[int] = None) -> list:
        """Search for record IDs (or records with fields)."""

    @abstractmethod
    def create(self, model: str, vals: dict) -> int:
        """Create a record, return its ID."""

    @abstractmethod
    def write(self, model: str, ids: list, vals: dict) -> bool:
        """Update records by IDs."""

    @abstractmethod
    def search_read(self, model: str, domain: list, fields: list,
                    limit: Optional[int] = None) -> list:
        """Search and read in one call."""

    @abstractmethod
    def execute(self, model: str, method: str, *args, **kwargs) -> Any:
        """Call an arbitrary model method."""

    @abstractmethod
    def get_field_info(self, model: str) -> dict[str, FieldInfo]:
        """Return field metadata for a model."""

    def check_access_rights(self, model: str, operation: str) -> bool:
        """Check user access rights. Default: no-op (RPC relies on server)."""
        return True

    def savepoint(self):
        """Return a context manager for savepoints. Default: no-op."""
        return _NullSavepoint()

    def flush_all(self) -> None:
        """Flush pending ORM writes. Default: no-op (RPC has no deferred writes)."""

    def browse_exists(self, model: str, record_id: int) -> bool:
        """Check if a record exists by ID."""
        result = self.search(model, [('id', '=', record_id)], limit=1)
        return len(result) > 0


def _make_ssl_context(verify: bool) -> 'ssl.SSLContext | None':
    """Return an SSL context for HTTPS connections.

    verify=False disables certificate checking — appropriate for desktop apps
    connecting to internal Odoo instances that may use self-signed or
    private-CA certificates not in Python's default trust store.
    """
    if verify:
        return None  # xmlrpc.client uses the default context (system CAs)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class RpcBackend(OdooBackend):
    """
    XML-RPC backend for standalone mode (Electron subprocess).
    Talks to any vanilla Odoo instance — no addon installation required.
    Thread-safe: each thread gets its own ServerProxy connection.
    """

    def __init__(self, url: str, db: str, uid: int, password: str,
                 timeout: int = RPC_TIMEOUT_SECONDS,
                 max_retries: int = RPC_MAX_RETRIES,
                 cancel_event: Optional[threading.Event] = None,
                 reporter: Optional[ProgressReporter] = None,
                 ssl_verify: bool = False):
        self.url = url
        self.db = db
        self.uid = uid
        self.password = password
        self.timeout = timeout
        self.max_retries = max_retries
        self.ssl_verify = ssl_verify
        self._cancel_event = cancel_event
        self._reporter: ProgressReporter = reporter or NullReporter()
        self._thread_local = threading.local()
        self._field_cache: dict[str, dict[str, FieldInfo]] = {}

    def _get_proxy(self) -> xmlrpc.client.ServerProxy:
        """Get a thread-local ServerProxy (each thread gets its own connection)."""
        if not hasattr(self._thread_local, 'proxy'):
            ctx = _make_ssl_context(self.ssl_verify) if self.url.startswith('https') else None
            self._thread_local.proxy = xmlrpc.client.ServerProxy(
                f'{self.url}{XMLRPC_OBJECT_PATH}',
                allow_none=True,
                context=ctx,
            )
        return self._thread_local.proxy

    def _is_cancelled(self) -> bool:
        return self._cancel_event is not None and self._cancel_event.is_set()

    def _check_connectivity(self) -> bool:
        """Quick TCP connect to verify the Odoo host is reachable."""
        from urllib.parse import urlparse
        parsed = urlparse(self.url)
        host = parsed.hostname or 'localhost'
        port = parsed.port or (443 if parsed.scheme == 'https' else 8069)
        try:
            with socket.create_connection((host, port), timeout=5):
                return True
        except (OSError, socket.timeout):
            return False

    def _wait_for_connectivity(self) -> bool:
        """
        Block until the server is reachable again or timeout/cancel.
        Returns True if connectivity was restored, False on timeout/cancel.
        """
        deadline = _time.monotonic() + RPC_RECONNECT_TIMEOUT
        self._reporter.connection_lost(
            f"Server unreachable. Waiting up to {RPC_RECONNECT_TIMEOUT}s for reconnect..."
        )
        _logger.warning(
            "Server unreachable after quick retries. "
            "Waiting up to %ds for connectivity...", RPC_RECONNECT_TIMEOUT
        )
        delay = 1  # exponential backoff: 1, 2, 4, 8, 16, 30, 30, ...
        while _time.monotonic() < deadline:
            if self._is_cancelled():
                return False
            remaining = deadline - _time.monotonic()
            _time.sleep(min(delay, max(0.0, remaining)))
            delay = min(delay * 2, 30)
            if self._check_connectivity():
                return True
        return False

    def _call(self, model: str, method: str, args: list,
              kwargs: Optional[dict] = None) -> Any:
        """
        Execute an XML-RPC call with timeout, retry, and reconnect wait.

        Three phases:
        1. Quick retries (3 attempts, 2/4/6s backoff) for transient blips
        2. Connectivity wait (up to 5 min) for extended outages
        3. One final retry after connectivity returns

        Odoo application errors (Fault) are NEVER retried.
        """
        last_error: Optional[Exception] = None

        # Phase 1: Quick retries
        for attempt in range(self.max_retries):
            if self._is_cancelled():
                raise RuntimeError("Import cancelled")
            old_timeout = socket.getdefaulttimeout()
            try:
                socket.setdefaulttimeout(self.timeout)
                proxy = self._get_proxy()
                return proxy.execute_kw(
                    self.db, self.uid, self.password,
                    model, method, args, kwargs or {}
                )
            except xmlrpc.client.Fault as e:
                # Odoo application error — don't retry
                raise ValueError(f"Odoo error: {e.faultString}") from e
            except (xmlrpc.client.ProtocolError, socket.timeout,
                    ConnectionError, OSError) as e:
                last_error = e
                if attempt < self.max_retries - 1:
                    delay = (attempt + 1) * RPC_RETRY_BACKOFF_MULTIPLIER
                    _logger.warning(
                        "RPC error (attempt %d/%d): %s. Retrying in %ds...",
                        attempt + 1, self.max_retries, e, delay
                    )
                    if hasattr(self._thread_local, 'proxy'):
                        del self._thread_local.proxy
                    _time.sleep(delay)
            finally:
                socket.setdefaulttimeout(old_timeout)

        # Phase 2: Connectivity wait — server might be temporarily down
        if self._wait_for_connectivity():
            # Phase 3: One final attempt after reconnect
            if hasattr(self._thread_local, 'proxy'):
                del self._thread_local.proxy
            old_timeout = socket.getdefaulttimeout()
            try:
                socket.setdefaulttimeout(self.timeout)
                proxy = self._get_proxy()
                result = proxy.execute_kw(
                    self.db, self.uid, self.password,
                    model, method, args, kwargs or {}
                )
                elapsed = RPC_RECONNECT_TIMEOUT  # approximate
                self._reporter.connection_restored(
                    f"Connection restored. Resuming import."
                )
                _logger.info("Connection restored after reconnect wait")
                return result
            except xmlrpc.client.Fault as e:
                raise ValueError(f"Odoo error: {e.faultString}") from e
            except (xmlrpc.client.ProtocolError, socket.timeout,
                    ConnectionError, OSError) as e:
                last_error = e
            finally:
                socket.setdefaulttimeout(old_timeout)

        raise TransportError(
            f"RPC failed after {self.max_retries} retries + reconnect wait: {last_error}"
        ) from last_error

    def search(self, model: str, domain: list,
               fields: Optional[list] = None,
               limit: Optional[int] = None) -> list:
        kwargs: dict = {}
        if limit is not None:
            kwargs['limit'] = limit
        ids = self._call(model, 'search', [domain], kwargs)
        if fields:
            return self._call(model, 'read', [ids], {'fields': fields})
        return ids

    def create(self, model: str, vals: dict) -> int:
        return self._call(model, 'create', [vals])

    def write(self, model: str, ids: list, vals: dict) -> bool:
        return self._call(model, 'write', [ids, vals])

    def search_read(self, model: str, domain: list, fields: list,
                    limit: Optional[int] = None) -> list:
        kwargs: dict = {'fields': fields}
        if limit is not None:
            kwargs['limit'] = limit
        return self._call(model, 'search_read', [domain], kwargs)

    def execute(self, model: str, method: str, *args, **kwargs) -> Any:
        return self._call(model, method, list(args), kwargs)

    def get_field_info(self, model: str) -> dict[str, FieldInfo]:
        if model in self._field_cache:
            return self._field_cache[model]

        raw = self._call(model, 'fields_get', [],
                         {'attributes': ['type', 'relation']})
        result = {}
        for name, info in raw.items():
            result[name] = FieldInfo(
                name=name,
                type=info.get('type', ''),
                comodel_name=info.get('relation', ''),
            )
        self._field_cache[model] = result
        return result

    def browse_exists(self, model: str, record_id: int) -> bool:
        ids = self._call(model, 'search',
                         [[('id', '=', record_id)]], {'limit': 1})
        return len(ids) > 0

    @classmethod
    def authenticate(cls, url: str, db: str, login: str,
                     password: str, ssl_verify: bool = False) -> 'RpcBackend':
        """Authenticate and return a connected RpcBackend."""
        ctx = _make_ssl_context(ssl_verify) if url.startswith('https') else None
        common = xmlrpc.client.ServerProxy(
            f'{url}{XMLRPC_COMMON_PATH}',
            allow_none=True,
            context=ctx,
        )
        uid = common.authenticate(db, login, password, {})
        if not uid:
            raise ValueError('Authentication failed')
        return cls(url, db, uid, password, ssl_verify=ssl_verify)
