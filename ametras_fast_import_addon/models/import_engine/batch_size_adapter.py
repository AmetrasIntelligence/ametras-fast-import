"""
Adaptive batch-size controller for the import engine.

Port of 16.0's BatchSizeAdapter (TypeScript) to Python.

The adapter tracks import outcomes and adjusts batch size up or down across
three levels: [1, min(10, max_size), max_size].  Thresholds count *rows*,
not batches, so behaviour scales naturally with the configured batch size.
"""
from __future__ import annotations

from .constants import (
    BATCH_SIZE_SUCCESS_THRESHOLD,
    BATCH_SIZE_FAILURE_THRESHOLD,
)


class BatchSizeAdapter:
    """
    Three-level adaptive batch-size controller.

    Levels are [1, min(10, max_size), max_size] deduplicated and sorted.
    The adapter starts at the middle level (index 1, or 0 if max_size <= 1).

    Threshold semantics (row-based, not batch-based):
    - Step UP  when accumulated successful rows >= success_threshold.
    - Step DOWN when consecutive batch failures >= FAILURE_THRESHOLD.
    - Step DOWN immediately on timeout; optionally raise the success threshold
      for the next ramp-up to prevent too-quick re-escalation.
    """

    def __init__(self, max_size: int):
        levels = sorted(set([1, min(10, max_size), max_size]))
        self._levels = levels
        self._level = min(1, len(levels) - 1)   # middle rung (or 0 if only 1 level)
        self._success_rows = 0
        self._consecutive_failures = 0
        self._success_threshold = BATCH_SIZE_SUCCESS_THRESHOLD

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def current_size(self) -> int:
        return self._levels[self._level]

    @property
    def is_at_minimum(self) -> bool:
        return self._level == 0

    # ------------------------------------------------------------------
    # Outcome recording
    # ------------------------------------------------------------------

    def record_success(self, row_count: int) -> None:
        """
        Record successfully processed rows.

        Resets the consecutive-failure counter and accumulates rows toward
        the step-up threshold.  Steps up at most one level per call.
        """
        self._consecutive_failures = 0
        self._success_rows += row_count
        if (self._success_rows >= self._success_threshold
                and self._level < len(self._levels) - 1):
            self._level += 1
            self._success_rows = 0
            self._success_threshold = BATCH_SIZE_SUCCESS_THRESHOLD

    def record_failure(self) -> None:
        """
        Record a failed batch (not a timeout — for those use record_timeout).

        Steps down one level after BATCH_SIZE_FAILURE_THRESHOLD consecutive
        failures; resets the failure counter on step-down.
        """
        self._success_rows = 0
        self._consecutive_failures += 1
        if self._consecutive_failures >= BATCH_SIZE_FAILURE_THRESHOLD:
            self._consecutive_failures = 0
            if self._level > 0:
                self._level -= 1

    def record_timeout(
        self,
        success_threshold_after_timeout: int | None = None,
    ) -> bool:
        """
        Record a timeout and immediately step down one level.

        Args:
            success_threshold_after_timeout: If provided, overrides the
                success threshold for the next ramp-up (use
                STANDALONE_POST_TIMEOUT_SUCCESS_THRESHOLD = 300 to slow
                re-escalation after a timeout).

        Returns:
            True if the adapter stepped down, False if already at minimum.
        """
        if self._level == 0:
            return False
        self._level -= 1
        self._consecutive_failures = 0
        self._success_rows = 0
        if success_threshold_after_timeout is not None:
            self._success_threshold = success_threshold_after_timeout
        return True

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def reset(self) -> None:
        """Reset to the initial middle level.  Call between import runs."""
        self._level = min(1, len(self._levels) - 1)
        self._success_rows = 0
        self._consecutive_failures = 0
        self._success_threshold = BATCH_SIZE_SUCCESS_THRESHOLD
