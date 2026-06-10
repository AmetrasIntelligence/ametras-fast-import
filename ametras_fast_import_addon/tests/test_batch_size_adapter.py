"""
Tests for BatchSizeAdapter.

Port of 16.0's batchSizeAdapter.test.ts scenarios to Python.
Run with: python3 ametras_fast_import_addon/tests/test_batch_size_adapter.py
"""
import os
import sys
import unittest

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.batch_size_adapter import BatchSizeAdapter
from import_engine.constants import (
    BATCH_SIZE_FAILURE_THRESHOLD,
    BATCH_SIZE_SUCCESS_THRESHOLD,
)


class TestLevelConstruction(unittest.TestCase):
    def test_three_rungs_for_large_max(self):
        self.assertEqual(BatchSizeAdapter(200)._levels, [1, 10, 200])

    def test_two_rungs_when_max_equals_mid(self):
        self.assertEqual(BatchSizeAdapter(10)._levels, [1, 10])

    def test_two_rungs_when_max_less_than_mid(self):
        self.assertEqual(BatchSizeAdapter(5)._levels, [1, 5])

    def test_one_rung_at_minimum(self):
        self.assertEqual(BatchSizeAdapter(1)._levels, [1])

    def test_levels_for_1000(self):
        self.assertEqual(BatchSizeAdapter(1000)._levels, [1, 10, 1000])

    def test_levels_for_50(self):
        self.assertEqual(BatchSizeAdapter(50)._levels, [1, 10, 50])

    def test_no_duplicates_sorted(self):
        for max_size in [1, 2, 10, 11, 100, 1000]:
            a = BatchSizeAdapter(max_size)
            self.assertEqual(a._levels, sorted(set(a._levels)), f"max_size={max_size}")


class TestStartingLevel(unittest.TestCase):
    def test_starts_at_middle_three_rungs(self):
        a = BatchSizeAdapter(200)
        self.assertEqual(a.current_size, 10)  # middle of [1, 10, 200]

    def test_starts_at_index_1_two_rungs(self):
        a = BatchSizeAdapter(5)
        self.assertEqual(a.current_size, 5)  # index 1 of [1, 5]

    def test_starts_at_index_0_one_rung(self):
        a = BatchSizeAdapter(1)
        self.assertEqual(a.current_size, 1)

    def test_is_at_minimum_false_for_three_rungs(self):
        self.assertFalse(BatchSizeAdapter(200).is_at_minimum)

    def test_is_at_minimum_true_for_one_rung(self):
        self.assertTrue(BatchSizeAdapter(1).is_at_minimum)


class TestRecordSuccess(unittest.TestCase):
    def test_step_up_after_threshold(self):
        a = BatchSizeAdapter(200)  # starts at 10
        a.record_success(BATCH_SIZE_SUCCESS_THRESHOLD)
        self.assertEqual(a.current_size, 200)

    def test_overshoot_is_fine(self):
        a = BatchSizeAdapter(200)
        a.record_success(BATCH_SIZE_SUCCESS_THRESHOLD + 20)
        self.assertEqual(a.current_size, 200)

    def test_no_step_up_below_threshold(self):
        a = BatchSizeAdapter(200)
        a.record_success(BATCH_SIZE_SUCCESS_THRESHOLD - 1)
        self.assertEqual(a.current_size, 10)

    def test_stays_at_max(self):
        a = BatchSizeAdapter(200)
        a.record_success(BATCH_SIZE_SUCCESS_THRESHOLD)
        a.record_success(BATCH_SIZE_SUCCESS_THRESHOLD + 1)
        self.assertEqual(a.current_size, 200)

    def test_resets_consecutive_failures(self):
        a = BatchSizeAdapter(200)
        a.record_failure()
        a.record_failure()
        a.record_success(1)
        self.assertEqual(a._consecutive_failures, 0)

    def test_accumulates_across_calls(self):
        a = BatchSizeAdapter(200)
        a.record_success(15)
        self.assertEqual(a.current_size, 10)
        a.record_success(15)
        self.assertEqual(a.current_size, 200)  # 30 total


class TestRecordFailure(unittest.TestCase):
    def test_step_down_after_threshold_failures(self):
        a = BatchSizeAdapter(200)  # starts at 10
        for _ in range(BATCH_SIZE_FAILURE_THRESHOLD):
            a.record_failure()
        self.assertEqual(a.current_size, 1)

    def test_multiple_rounds_step_down_further(self):
        a = BatchSizeAdapter(200)  # [1, 10, 200]
        a.record_success(BATCH_SIZE_SUCCESS_THRESHOLD)  # 10 → 200
        self.assertEqual(a.current_size, 200)
        for _ in range(BATCH_SIZE_FAILURE_THRESHOLD):
            a.record_failure()
        self.assertEqual(a.current_size, 10)
        for _ in range(BATCH_SIZE_FAILURE_THRESHOLD):
            a.record_failure()
        self.assertEqual(a.current_size, 1)

    def test_stays_at_floor(self):
        a = BatchSizeAdapter(200)
        for _ in range(BATCH_SIZE_FAILURE_THRESHOLD * 3):
            a.record_failure()
        self.assertEqual(a.current_size, 1)
        self.assertTrue(a.is_at_minimum)

    def test_resets_failure_counter_on_step_down(self):
        a = BatchSizeAdapter(200)
        for _ in range(BATCH_SIZE_FAILURE_THRESHOLD):
            a.record_failure()
        self.assertEqual(a._consecutive_failures, 0)

    def test_resets_success_rows(self):
        a = BatchSizeAdapter(200)
        a.record_success(15)
        a.record_failure()
        self.assertEqual(a._success_rows, 0)


class TestRecordTimeout(unittest.TestCase):
    def test_immediate_step_down(self):
        a = BatchSizeAdapter(200)  # starts at 10
        result = a.record_timeout()
        self.assertTrue(result)
        self.assertEqual(a.current_size, 1)

    def test_returns_false_at_minimum(self):
        a = BatchSizeAdapter(200)
        a.record_timeout()  # 10 → 1
        result = a.record_timeout()
        self.assertFalse(result)
        self.assertEqual(a.current_size, 1)

    def test_returns_false_for_one_rung(self):
        self.assertFalse(BatchSizeAdapter(1).record_timeout())

    def test_resets_counters(self):
        a = BatchSizeAdapter(200)
        a.record_failure()
        a.record_success(15)
        a.record_timeout()
        self.assertEqual(a._consecutive_failures, 0)
        self.assertEqual(a._success_rows, 0)

    def test_elevated_success_threshold(self):
        elevated = 300
        a = BatchSizeAdapter(200)  # starts at 10
        a.record_timeout(success_threshold_after_timeout=elevated)
        # Now at level 0 (size=1). Need 300 rows to step up.
        a.record_success(BATCH_SIZE_SUCCESS_THRESHOLD)  # 30 — not enough
        self.assertEqual(a.current_size, 1)
        a.record_success(elevated - BATCH_SIZE_SUCCESS_THRESHOLD)  # 270 more
        self.assertEqual(a.current_size, 10)  # stepped up

    def test_normal_threshold_restored_after_step_up(self):
        a = BatchSizeAdapter(200)
        a.record_timeout(success_threshold_after_timeout=300)
        a.record_success(300)  # step up: 1 → 10; threshold resets to 30
        self.assertEqual(a.current_size, 10)
        a.record_success(BATCH_SIZE_SUCCESS_THRESHOLD)
        self.assertEqual(a.current_size, 200)  # normal threshold applied

    def test_is_at_minimum_after_full_step_down(self):
        a = BatchSizeAdapter(200)
        a.record_timeout()  # 10 → 1
        self.assertTrue(a.is_at_minimum)


class TestReset(unittest.TestCase):
    def test_reset_returns_to_middle(self):
        a = BatchSizeAdapter(200)
        a.record_success(BATCH_SIZE_SUCCESS_THRESHOLD)
        self.assertEqual(a.current_size, 200)
        a.reset()
        self.assertEqual(a.current_size, 10)

    def test_reset_clears_counters(self):
        a = BatchSizeAdapter(200)
        a.record_failure()
        a.record_success(10)
        a.reset()
        self.assertEqual(a._consecutive_failures, 0)
        self.assertEqual(a._success_rows, 0)


if __name__ == "__main__":
    unittest.main()
