"""
Backend abstraction for Odoo operations.

OdooBackend is the abstract interface. Two implementations:
- RpcBackend: XML-RPC to any vanilla Odoo (no addon needed). Lives here.
- OrmBackend: Direct ORM access inside Odoo. Lives in models/orm_backend.py.
"""
from __future__ import annotations

import logging
import socket
import threading
import time as _time
import xmlrpc.client
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Optional

from .constants import (
    RPC_TIMEOUT_SECONDS, RPC_MAX_RETRIES, RPC_RETRY_BACKOFF_MULTIPLIER,
    XMLRPC_OBJECT_PATH, XMLRPC_COMMON_PATH,
)

_logger = logging.getLogger(__name__)


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

    def browse_exists(self, model: str, record_id: int) -> bool:
        """Check if a record exists by ID."""
        result = self.search(model, [('id', '=', record_id)], limit=1)
        return len(result) > 0


class RpcBackend(OdooBackend):
    """
    XML-RPC backend for standalone mode (Electron subprocess).
    Talks to any vanilla Odoo instance — no addon installation required.
    Thread-safe: each thread gets its own ServerProxy connection.
    """

    def __init__(self, url: str, db: str, uid: int, password: str,
                 timeout: int = RPC_TIMEOUT_SECONDS,
                 max_retries: int = RPC_MAX_RETRIES):
        self.url = url
        self.db = db
        self.uid = uid
        self.password = password
        self.timeout = timeout
        self.max_retries = max_retries
        self._thread_local = threading.local()
        self._field_cache: dict[str, dict[str, FieldInfo]] = {}

    def _get_proxy(self) -> xmlrpc.client.ServerProxy:
        """Get a thread-local ServerProxy (each thread gets its own connection)."""
        if not hasattr(self._thread_local, 'proxy'):
            self._thread_local.proxy = xmlrpc.client.ServerProxy(
                f'{self.url}{XMLRPC_OBJECT_PATH}',
                allow_none=True,
            )
        return self._thread_local.proxy

    def _call(self, model: str, method: str, args: list,
              kwargs: Optional[dict] = None) -> Any:
        """
        Execute an XML-RPC call with timeout and retry.

        Retries transient network errors with exponential backoff.
        Odoo application errors (Fault) are NOT retried.
        """
        last_error: Optional[Exception] = None
        for attempt in range(self.max_retries):
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
                    # Clear thread-local proxy for fresh connection
                    if hasattr(self._thread_local, 'proxy'):
                        del self._thread_local.proxy
                    _time.sleep(delay)
            finally:
                socket.setdefaulttimeout(old_timeout)

        raise RuntimeError(
            f"RPC failed after {self.max_retries} attempts: {last_error}"
        )

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
                     password: str) -> 'RpcBackend':
        """Authenticate and return a connected RpcBackend."""
        common = xmlrpc.client.ServerProxy(
            f'{url}{XMLRPC_COMMON_PATH}',
            allow_none=True,
        )
        uid = common.authenticate(db, login, password, {})
        if not uid:
            raise ValueError('Authentication failed')
        return cls(url, db, uid, password)
