"""
End-to-end tests for the timeout-resilience pipeline in Importer.

Uses a fake backend that raises TransportError deterministically to test
shrink-on-timeout, exponential backoff, and idempotency guard.
Run with: python3 -m pytest ametras_fast_import_addon/tests/test_importer_timeout_pipeline.py
"""
import sys
import os
import time
from unittest.mock import MagicMock, patch

_engine_path = os.path.join(os.path.dirname(__file__), '..', 'models')
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

import unittest
from import_engine.backend import OdooBackend, FieldInfo, TransportError
from import_engine.importer import Importer, ImportConfig, RowResult
from import_engine.parser import ParsedRow


def make_rows(n: int, with_id: bool = True) -> list:
    return [
        ParsedRow(
            index=i,
            data=dict({'name': f'Test{i}'}, id=f'mod.rec{i}') if with_id else {'name': f'Test{i}'}
        )
        for i in range(1, n + 1)
    ]


class FakeRpcBackend(OdooBackend):
    """Fake backend that raises TransportError on a schedule."""

    def __init__(self, fail_indices: set):
        self.fail_indices = fail_indices
        self._call_count = 0
        self.create_calls = []
        self._fields = {'name': FieldInfo('name', 'char'), 'id': FieldInfo('id', 'char')}

    def search(self, model, domain, fields=None, limit=None):
        return []

    def create(self, model, vals):
        self._call_count += 1
        if self._call_count in self.fail_indices:
            raise TransportError(f"Simulated timeout on call {self._call_count}")
        self.create_calls.append(vals)
        return self._call_count

    def write(self, model, ids, vals):
        return True

    def search_read(self, model, domain, fields, limit=None):
        return []

    def execute(self, model, method, *args, **kwargs):
        return []

    def get_field_info(self, model):
        return self._fields


def make_config(batch_size=10, with_id=True) -> ImportConfig:
    mappings = {'name': 'name'}
    if with_id:
        mappings['id'] = 'id'
    return ImportConfig(
        model='res.partner',
        field_mappings=mappings,
        batch_size=batch_size,
    )


def run_retry(importer: Importer, rows: list):
    """Call _import_sequential_with_retry; returns (success, failed, error_rows)."""
    with patch('time.sleep'):
        all_errors = []
        success, failed = importer._import_sequential_with_retry(
            importer._iter_batches(iter(rows), importer.config.batch_size),
            all_errors,
            len(rows),
        )
    return success, failed, all_errors


class TestShrinkOnTimeout(unittest.TestCase):
    def test_first_timeout_shrinks_and_retries(self):
        """Adapter steps down on first timeout; import succeeds at smaller batch."""
        backend = FakeRpcBackend(fail_indices={1})
        config = make_config(batch_size=10)
        importer = Importer(backend, config)

        rows = make_rows(5, with_id=True)
        success, failed, _ = run_retry(importer, rows)

        self.assertGreater(success, 0, "Some rows should succeed after shrink")

    def test_no_timeout_means_no_shrink(self):
        """Happy path: no errors, adapter stays at initial level."""
        backend = FakeRpcBackend(fail_indices=set())
        config = make_config(batch_size=10)
        importer = Importer(backend, config)

        rows = make_rows(3, with_id=True)
        success, failed, errors = run_retry(importer, rows)

        self.assertEqual(failed, 0)
        self.assertEqual(success, 3)
        self.assertEqual(errors, [])


class TestIdempotencyGuard(unittest.TestCase):
    def test_unsafe_rows_fail_without_retry(self):
        """Rows without id/.id are failed immediately at minimum batch size."""
        backend = FakeRpcBackend(fail_indices={1})
        config = make_config(batch_size=1, with_id=False)
        importer = Importer(backend, config)

        rows = make_rows(2, with_id=False)

        with patch('time.sleep'):
            all_errors = []
            importer._import_sequential_with_retry(
                importer._iter_batches(iter(rows), importer.config.batch_size),
                all_errors,
                len(rows),
            )

        idm_errors = [r for r in all_errors if 'safe retry skipped' in (r.error or '')]
        self.assertGreaterEqual(len(idm_errors), 1)

    def test_safe_rows_retried_after_timeout(self):
        """Rows with id are retried after timeout; succeed on second call."""
        call_count = [0]

        class FailOnceThenSucceed(FakeRpcBackend):
            def create(self, model, vals):
                call_count[0] += 1
                if call_count[0] == 1:
                    raise TransportError("Simulated timeout")
                self.create_calls.append(vals)
                return call_count[0]

        backend = FailOnceThenSucceed(fail_indices=set())
        config = make_config(batch_size=1, with_id=True)
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'name': 'A', 'id': 'mod.recA'})]

        with patch('time.sleep'):
            all_errors = []
            success, failed = importer._import_sequential_with_retry(
                importer._iter_batches(iter(rows), importer.config.batch_size),
                all_errors,
                1,
            )

        self.assertEqual(success, 1)
        self.assertEqual(failed, 0)


class TestBudgetEnforcement(unittest.TestCase):
    def test_budget_exhausted_fails_remaining_rows(self):
        """When retry budget runs out, remaining safe rows are failed with clear message."""
        from import_engine.constants import STANDALONE_TIMEOUT_RETRY_BUDGET_SECONDS

        class AlwaysTimeout(FakeRpcBackend):
            def create(self, model, vals):
                raise TransportError("Always fails")

        backend = AlwaysTimeout(fail_indices=set())
        config = make_config(batch_size=1, with_id=True)
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'name': 'A', 'id': 'mod.recA'})]

        with patch('time.sleep'), \
             patch('time.monotonic', side_effect=[
                 0,                                        # budget_start
                 0,                                        # 1st elapsed check — not exhausted
                 0,                                        # sleep_start
                 2.0,                                      # sleep-loop exit (2.0 - 0 >= 1.0)
                 STANDALONE_TIMEOUT_RETRY_BUDGET_SECONDS + 1,  # 2nd elapsed check — exhausted
             ]):
            all_errors = []
            success, failed = importer._import_sequential_with_retry(
                importer._iter_batches(iter(rows), importer.config.batch_size),
                all_errors,
                1,
            )

        self.assertEqual(len(all_errors), 1)
        self.assertFalse(all_errors[0].ok)
        self.assertIn('budget exhausted', all_errors[0].error.lower())


if __name__ == '__main__':
    unittest.main()
