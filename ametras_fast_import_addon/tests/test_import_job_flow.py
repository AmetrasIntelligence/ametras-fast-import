"""
Unit tests for ImportJob control-flow and helpers.

Covers: _evaluate_control, _check_control, _wait_if_paused,
_filter_pending_rows, _init_file_state, _mark_file_skipped,
FileRunState.cumulative_success, and _indices_to_ranges.

No Odoo ORM needed — all Odoo objects are replaced with lightweight fakes.
Run with: python3 ametras_fast_import_addon/tests/test_import_job_flow.py
"""
import unittest
import sys
import os
import json
import time
from unittest.mock import MagicMock, call, patch

# import_job.py uses relative imports (from .orm_backend, from .import_engine.*)
# so it must be loaded as part of a package.  We register a fake package called
# "models" that points at the real models/ directory, then pre-populate every
# relative dependency with stubs before exec-ing the module.

import types
import importlib.util

_engine_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'models'))

# ── fake top-level "odoo" package ──────────────────────────────────────────
odoo_mod = types.ModuleType('odoo')
odoo_fields_mod = types.ModuleType('odoo.fields')

class _FakeDatetime:
    @staticmethod
    def now():
        import datetime
        return datetime.datetime.utcnow()

odoo_fields_mod.Datetime = _FakeDatetime
odoo_mod.fields = odoo_fields_mod

sys.modules.setdefault('odoo', odoo_mod)
sys.modules.setdefault('odoo.fields', odoo_fields_mod)

# ── fake "models" package (the parent of import_job) ──────────────────────
models_pkg = types.ModuleType('models')
models_pkg.__path__ = [_engine_path]
models_pkg.__package__ = 'models'
sys.modules['models'] = models_pkg

# ── stubs for the relative imports inside import_job.py ───────────────────
def _stub(name):
    m = types.ModuleType(name)
    sys.modules[name] = m
    return m

_stub('models.orm_backend').OrmBackend = type('OrmBackend', (), {'__init__': lambda s, *a, **kw: None})

_constants = _stub('models.import_engine')
_constants = _stub('models.import_engine.constants')
_constants.PROGRESS_COMMIT_INTERVAL = 10

_parser = _stub('models.import_engine.parser')
_parser.ParseOptions = type('ParseOptions', (), {'__init__': lambda s, **kw: None})
_parser.parse_csv_string = lambda *a, **kw: []
_parser.parse_csv_file = lambda *a, **kw: iter([])
_parser.count_csv_rows = lambda *a, **kw: 0
_parser.extract_rows_by_index = lambda *a, **kw: iter([])

_importer = _stub('models.import_engine.importer')
_importer.ImportConfig = type('ImportConfig', (), {'__init__': lambda s, **kw: None})
_importer.Importer = type('Importer', (), {'__init__': lambda s, *a, **kw: None})

# ── load import_job.py as models.import_job ───────────────────────────────
import importlib
_import_job_path = os.path.join(_engine_path, 'import_job.py')
_spec = importlib.util.spec_from_file_location(
    'models.import_job',
    _import_job_path,
    submodule_search_locations=[],
)
import_job_module = importlib.util.module_from_spec(_spec)
import_job_module.__package__ = 'models'
sys.modules['models.import_job'] = import_job_module
_spec.loader.exec_module(import_job_module)
ImportJob = import_job_module.ImportJob
ControlSignal = import_job_module.ControlSignal
ControlDecision = import_job_module.ControlDecision
FileRunState = import_job_module.FileRunState


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_log(cancel=False, pause=False, skip_file='', log_id=1, table='csv_import_log'):
    log = MagicMock()
    log.id = log_id
    log._table = table
    log.job_cancel_requested = cancel
    log.job_pause_requested = pause
    log.job_skip_file = skip_file
    log.file_progress = '{}'
    log.error_log = '[]'
    return log


def _make_env(db_rows):
    """Fake Odoo env whose cr.fetchone() yields rows from db_rows in order."""
    env = MagicMock()
    env.cr.fetchone.side_effect = list(db_rows)
    return env


def _make_job(cancel=False, pause=False, skip_file='', db_rows=None):
    """Convenience: build an ImportJob with faked log + env."""
    if db_rows is None:
        db_rows = [(cancel, pause, skip_file)]
    log = _make_log(cancel=cancel, pause=pause, skip_file=skip_file)
    log.env = _make_env(db_rows)
    job = ImportJob(log)
    job.env = log.env
    return job


# ---------------------------------------------------------------------------
# FileRunState
# ---------------------------------------------------------------------------

class TestFileRunState(unittest.TestCase):
    def test_cumulative_success_adds_base(self):
        s = FileRunState(filename='f.csv', base_success=10)
        s.success = 5
        self.assertEqual(s.cumulative_success, 15)

    def test_cumulative_success_zero_base(self):
        s = FileRunState(filename='f.csv')
        s.success = 3
        self.assertEqual(s.cumulative_success, 3)


# ---------------------------------------------------------------------------
# _check_control
# ---------------------------------------------------------------------------

class TestCheckControl(unittest.TestCase):
    def test_returns_cancel_when_flag_set(self):
        job = _make_job(cancel=True, db_rows=[(True, False, '')])
        self.assertEqual(job._check_control(), ControlSignal.CANCEL)

    def test_returns_skip_when_skip_file_set(self):
        job = _make_job(skip_file='a.csv', db_rows=[(False, False, 'a.csv')])
        self.assertEqual(job._check_control(), ControlSignal.SKIP)

    def test_returns_continue_when_clean(self):
        job = _make_job(db_rows=[(False, False, '')])
        self.assertEqual(job._check_control(), ControlSignal.CONTINUE)

    def test_cancel_beats_skip(self):
        """Cancel flag takes precedence even if skip_file is also set."""
        job = _make_job(db_rows=[(True, False, 'a.csv')])
        self.assertEqual(job._check_control(), ControlSignal.CANCEL)


# ---------------------------------------------------------------------------
# _evaluate_control
# ---------------------------------------------------------------------------

class TestEvaluateControl(unittest.TestCase):
    def test_cancel_returns_stop(self):
        # Two DB reads: _check_control + post-wait _check_control
        job = _make_job(db_rows=[(True, False, ''), (True, False, '')])
        self.assertEqual(job._evaluate_control('f.csv'), ControlDecision.STOP)

    def test_skip_matching_filename_returns_skip_file(self):
        # _check_control returns SKIP for 'f.csv'; _wait_if_paused reads once (not paused)
        job = _make_job(db_rows=[
            (False, False, 'f.csv'),   # _check_control → SKIP
        ])
        self.assertEqual(job._evaluate_control('f.csv'), ControlDecision.SKIP_FILE)

    def test_skip_different_filename_returns_continue(self):
        # Skip is for 'other.csv', not 'f.csv' — should pass through
        job = _make_job(db_rows=[
            (False, False, 'other.csv'),  # _check_control → SKIP (different file)
            (False, False, 'other.csv'),  # _wait_if_paused: not paused, exits immediately
            (False, False, 'other.csv'),  # post-wait _check_control → CONTINUE (no cancel)
        ])
        self.assertEqual(job._evaluate_control('f.csv'), ControlDecision.CONTINUE)

    def test_no_signals_returns_continue(self):
        job = _make_job(db_rows=[
            (False, False, ''),  # _check_control → CONTINUE
            (False, False, ''),  # _wait_if_paused: not paused
            (False, False, ''),  # post-wait _check_control → CONTINUE
        ])
        self.assertEqual(job._evaluate_control('f.csv'), ControlDecision.CONTINUE)

    def test_cancel_after_pause_returns_stop(self):
        """Cancel issued while paused is respected after the wait loop exits."""
        with patch('time.sleep'):
            job = _make_job(db_rows=[
                (False, False, ''),   # _check_control → CONTINUE (enter pause check)
                (False, True,  ''),   # _wait_if_paused 1st poll: paused → sleep
                (True,  False, ''),   # _wait_if_paused 2nd poll: cancel → exit
                (True,  False, ''),   # post-wait _check_control → CANCEL
            ])
            self.assertEqual(job._evaluate_control('f.csv'), ControlDecision.STOP)


# ---------------------------------------------------------------------------
# _filter_pending_rows
# ---------------------------------------------------------------------------

class _FakeRow:
    def __init__(self, index): self.index = index


class TestFilterPendingRows(unittest.TestCase):
    def setUp(self):
        self.job = _make_job()

    def test_none_for_fresh_file(self):
        rows = [_FakeRow(i) for i in range(1, 4)]
        self.assertIsNone(self.job._filter_pending_rows('new.csv', rows, {}))

    def test_empty_for_already_skipped(self):
        rows = [_FakeRow(i) for i in range(1, 4)]
        fp = {'f.csv': {'skipped': True}}
        self.assertEqual(self.job._filter_pending_rows('f.csv', rows, fp), [])

    def test_filters_already_processed_rows(self):
        rows = [_FakeRow(i) for i in range(1, 6)]
        fp = {'f.csv': {'processedRanges': [[1, 3]], 'totalRows': 5, 'failedIndices': []}}
        pending = self.job._filter_pending_rows('f.csv', rows, fp)
        self.assertEqual([r.index for r in pending], [4, 5])

    def test_includes_failed_indices_for_retry(self):
        rows = [_FakeRow(i) for i in range(1, 6)]
        # Rows 1-3 processed, row 2 failed → should be re-included
        fp = {'f.csv': {
            'processedRanges': [[1, 3]],
            'totalRows': 5,
            'failedIndices': [2],
        }}
        pending = self.job._filter_pending_rows('f.csv', rows, fp)
        indices = [r.index for r in pending]
        self.assertIn(2, indices)   # failed row re-included
        self.assertIn(4, indices)   # unprocessed rows included
        self.assertNotIn(1, indices)
        self.assertNotIn(3, indices)

    def test_empty_when_all_processed_no_failures(self):
        rows = [_FakeRow(i) for i in range(1, 4)]
        fp = {'f.csv': {'processedRanges': [[1, 3]], 'totalRows': 3, 'failedIndices': []}}
        self.assertEqual(self.job._filter_pending_rows('f.csv', rows, fp), [])


# ---------------------------------------------------------------------------
# _init_file_state
# ---------------------------------------------------------------------------

class TestInitFileState(unittest.TestCase):
    def setUp(self):
        self.job = _make_job()

    def test_fresh_file_zero_base(self):
        state = self.job._init_file_state('f.csv', 3, {})
        self.assertEqual(state.base_success, 0)
        self.assertEqual(state.original_total, 3)
        self.assertEqual(len(state.processed_indices), 0)

    def test_resume_loads_base_success_and_processed(self):
        fp = {'f.csv': {
            'successCount': 7,
            'totalRows': 10,
            'processedRanges': [[1, 3]],
        }}
        state = self.job._init_file_state('f.csv', 5, fp)
        self.assertEqual(state.base_success, 7)
        self.assertEqual(state.original_total, 10)
        self.assertIn(1, state.processed_indices)
        self.assertIn(3, state.processed_indices)
        self.assertNotIn(4, state.processed_indices)


# ---------------------------------------------------------------------------
# _mark_file_skipped
# ---------------------------------------------------------------------------

class TestMarkFileSkipped(unittest.TestCase):
    def test_sets_skipped_flag_and_clears_skip_file(self):
        job = _make_job()
        fp = {}
        job._mark_file_skipped('f.csv', fp)
        self.assertTrue(fp['f.csv'].get('skipped'))
        self.assertNotIn('failedIndices', fp['f.csv'])
        job.log.write.assert_called_once()
        written = job.log.write.call_args[0][0]
        self.assertEqual(written['job_skip_file'], '')


# ---------------------------------------------------------------------------
# _indices_to_ranges
# ---------------------------------------------------------------------------

class TestIndicesToRanges(unittest.TestCase):
    def test_empty_set(self):
        self.assertEqual(ImportJob._indices_to_ranges(set()), [])

    def test_single_element(self):
        self.assertEqual(ImportJob._indices_to_ranges({5}), [[5, 5]])

    def test_consecutive_merged(self):
        self.assertEqual(ImportJob._indices_to_ranges({1, 2, 3}), [[1, 3]])

    def test_gaps_produce_multiple_ranges(self):
        self.assertEqual(
            ImportJob._indices_to_ranges({1, 2, 5, 6, 10}),
            [[1, 2], [5, 6], [10, 10]],
        )

    def test_unsorted_input(self):
        self.assertEqual(ImportJob._indices_to_ranges({3, 1, 2}), [[1, 3]])


# ---------------------------------------------------------------------------
# _process_retries
# ---------------------------------------------------------------------------

class TestProcessRetries(unittest.TestCase):
    def test_no_errors_returns_empty(self):
        job = _make_job(db_rows=[(False, False, '')] * 10)
        importer = MagicMock()
        result = job._process_retries(importer, [], {}, all_rows=[])
        self.assertEqual(result, [])
        importer.import_rows.assert_not_called()

    def test_retries_failed_rows(self):
        job = _make_job(db_rows=[(False, False, '')] * 10)

        class FakeResult:
            def __init__(self, index, ok):
                self.row_index = index
                self.ok = ok
                self.error = None if ok else 'err'

        importer = MagicMock()
        importer.import_rows.return_value = [FakeResult(2, True)]

        rows = [_FakeRow(1), _FakeRow(2)]
        errors = [{'filename': 'f.csv', 'rowNumber': 2, 'error': 'err'}]

        with patch('time.sleep'):
            results = job._process_retries(
                importer, errors, {'retryLimit': 1, 'retryDelayMs': 0},
                all_rows=rows,
            )

        self.assertEqual(len(results), 1)
        self.assertTrue(results[0]['ok'])
        self.assertEqual(results[0]['rowNumber'], 2)

    def test_cancel_during_retry_stops_early(self):
        """If cancel is issued before a retry attempt, no further imports run."""
        # First _check_control call during retry sees cancel
        job = _make_job(db_rows=[(True, False, '')] * 5)

        importer = MagicMock()
        rows = [_FakeRow(1)]
        errors = [{'filename': 'f.csv', 'rowNumber': 1, 'error': 'err'}]

        with patch('time.sleep'):
            results = job._process_retries(
                importer, errors, {'retryLimit': 3, 'retryDelayMs': 0},
                all_rows=rows,
            )

        importer.import_rows.assert_not_called()


if __name__ == '__main__':
    unittest.main()
