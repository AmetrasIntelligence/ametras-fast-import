"""
Regression tests for serialization/deadlock retry in the RPC backend (APX-3830).

Parallel import workers can contend on a shared ir.sequence row, so a
create/write comes back as a PostgreSQL SerializationFailure / DeadlockDetected
(surfaced over XML-RPC as a Fault). Such an error guarantees the server
transaction rolled back, so re-sending the same call is duplicate-safe. The
backend now retries these — bounded, cancellable, and always terminating — so a
transient contention error no longer becomes a permanent row failure, and can
never hang the import.

Run with:
    python3 ametras_fast_import_addon/tests/test_backend_serialization_retry.py
"""
import os
import sys
import threading
import unittest
import xmlrpc.client
from unittest.mock import MagicMock

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.backend import RpcBackend  # noqa: E402
from import_engine.constants import (  # noqa: E402
    SERIALIZATION_RETRY_MAX_ATTEMPTS,
)

SERIALIZATION_FAULT = xmlrpc.client.Fault(
    2,
    "psycopg2.errors.SerializationFailure: could not serialize access "
    "due to concurrent update",
)
DEADLOCK_FAULT = xmlrpc.client.Fault(2, "psycopg2.errors.DeadlockDetected: deadlock detected")
GERMAN_SERIALIZATION_FAULT = xmlrpc.client.Fault(
    2, "konnte Zugriff nicht serialisieren wegen gleichzeitiger Aktualisierung"
)
BUSINESS_FAULT = xmlrpc.client.Fault(2, "ValidationError: Field X is required")


class TestSerializationRetry(unittest.TestCase):
    def _backend(self, cancel_event=None):
        backend = RpcBackend(
            "http://localhost:8069", "db", 2, "pw", cancel_event=cancel_event
        )
        # Neutralise real backoff sleeping so tests are fast; the cancellation
        # test below installs its own sleep behaviour.
        backend._cancellable_sleep = lambda delay: None
        proxy = MagicMock()
        backend._get_proxy = lambda: proxy
        return backend, proxy

    def test_retries_serialization_then_succeeds(self):
        backend, proxy = self._backend()
        proxy.execute_kw.side_effect = [SERIALIZATION_FAULT, SERIALIZATION_FAULT, 99]
        result = backend.create("product.template", {"name": "Widget"})
        self.assertEqual(result, 99)
        self.assertEqual(proxy.execute_kw.call_count, 3)

    def test_retries_deadlock_then_succeeds(self):
        backend, proxy = self._backend()
        proxy.execute_kw.side_effect = [DEADLOCK_FAULT, 7]
        self.assertEqual(backend.create("product.template", {"name": "W"}), 7)
        self.assertEqual(proxy.execute_kw.call_count, 2)

    def test_retries_german_serialization_message(self):
        backend, proxy = self._backend()
        proxy.execute_kw.side_effect = [GERMAN_SERIALIZATION_FAULT, 5]
        self.assertEqual(backend.write("product.template", [1], {"name": "W"}), 5)
        self.assertEqual(proxy.execute_kw.call_count, 2)

    def test_non_concurrency_fault_not_retried(self):
        backend, proxy = self._backend()
        proxy.execute_kw.side_effect = BUSINESS_FAULT
        with self.assertRaises(ValueError) as ctx:
            backend.create("product.template", {"name": "W"})
        self.assertIn("Odoo error", str(ctx.exception))
        self.assertEqual(proxy.execute_kw.call_count, 1)  # no retry

    def test_bounded_exhaustion_raises_value_error(self):
        backend, proxy = self._backend()
        # Always fails with serialization → retries are bounded, then it gives
        # up as a normal row failure (ValueError), never loops forever.
        proxy.execute_kw.side_effect = xmlrpc.client.Fault(
            2, "could not serialize access due to concurrent update"
        )
        with self.assertRaises(ValueError):
            backend.create("product.template", {"name": "W"})
        self.assertEqual(
            proxy.execute_kw.call_count, SERIALIZATION_RETRY_MAX_ATTEMPTS + 1
        )

    def test_cancellation_during_backoff_aborts(self):
        event = threading.Event()
        backend = RpcBackend("http://localhost:8069", "db", 2, "pw", cancel_event=event)
        proxy = MagicMock()

        def _fail_and_cancel(*args, **kwargs):
            # The cancel arrives while we're about to back off after a failure.
            event.set()
            raise SERIALIZATION_FAULT

        proxy.execute_kw.side_effect = _fail_and_cancel
        backend._get_proxy = lambda: proxy
        # Real _cancellable_sleep sees the cancel flag on entry and aborts,
        # rather than sleeping out the backoff or retrying.
        with self.assertRaises(RuntimeError) as ctx:
            backend.create("product.template", {"name": "W"})
        self.assertIn("cancelled", str(ctx.exception).lower())
        self.assertEqual(proxy.execute_kw.call_count, 1)  # failed once, then aborted


if __name__ == "__main__":
    unittest.main(verbosity=2)
