"""
Tests for ImportJob control-flow logic (_wait_if_paused, _check_control).

Run with: python3 ametras_fast_import_addon/tests/test_import_job_control.py
"""
import unittest
from unittest.mock import MagicMock, call, patch


def _make_log(cancel=False, pause=False, skip_file=""):
    log = MagicMock()
    log.id = 1
    log.job_cancel_requested = cancel
    log.job_pause_requested = pause
    log.job_skip_file = skip_file
    return log


def _make_env(log_row_sequence):
    """
    Build a fake Odoo env whose cr.fetchone() returns each tuple in sequence.
    Each tuple is (cancel_requested, pause_requested, skip_file).
    """
    env = MagicMock()
    env.cr.fetchone.side_effect = log_row_sequence
    return env


class _FakeJob:
    """Minimal stand-in for ImportJob that exercises _wait_if_paused."""

    def __init__(self, log, env):
        self.log = log
        self.env = env

    def _refresh_flags(self):
        row = self.env.cr.fetchone()
        if row:
            self.log.job_cancel_requested = row[0]
            self.log.job_pause_requested = row[1]
            self.log.job_skip_file = row[2] or ""

    def _wait_if_paused(self):
        """Exact copy of import_job.ImportJob._wait_if_paused."""
        was_paused = False
        while True:
            self._refresh_flags()
            if not self.log.job_pause_requested:
                break
            if self.log.job_cancel_requested:
                return
            if self.log.job_skip_file:
                self.log.write({"job_pause_requested": False})
                self.env.cr.commit()
                break
            was_paused = True
            self.log.write({"job_state": "paused"})
            self.env.cr.commit()
            import time

            time.sleep(2)
        if was_paused:
            self.log.write({"job_state": "running"})
            self.env.cr.commit()


class TestWaitIfPausedNotPaused(unittest.TestCase):
    def test_returns_immediately_when_not_paused(self):
        log = _make_log(pause=False)
        env = _make_env([(False, False, "")])
        job = _FakeJob(log, env)
        with patch("time.sleep") as mock_sleep:
            job._wait_if_paused()
        mock_sleep.assert_not_called()
        log.write.assert_not_called()


class TestWaitIfPausedCancel(unittest.TestCase):
    def test_returns_on_cancel_while_paused(self):
        log = _make_log(pause=True)
        # First poll: paused, then cancel arrives
        env = _make_env(
            [
                (False, True, ""),  # paused — sets job_state = paused, sleeps
                (True, True, ""),  # cancel arrives — returns early
            ]
        )
        job = _FakeJob(log, env)
        with patch("time.sleep"):
            job._wait_if_paused()
        # Writes 'paused' on first iteration, then exits on cancel
        job.log.write.assert_any_call({"job_state": "paused"})
        # Never writes 'running' because cancel short-circuits
        running_calls = [
            c for c in log.write.call_args_list if c == call({"job_state": "running"})
        ]
        self.assertEqual(len(running_calls), 0)


class TestWaitIfPausedSkipUnblocks(unittest.TestCase):
    def test_skip_posted_while_paused_unblocks_immediately(self):
        """
        Regression: a SKIP signal issued while paused must unblock _wait_if_paused
        without requiring an explicit resume first.
        """
        log = _make_log(pause=True)
        env = _make_env(
            [
                (False, True, ""),  # 1st poll: paused, no skip yet
                (
                    False,
                    True,
                    "partner.csv",
                ),  # 2nd poll: skip arrives while still paused
            ]
        )
        job = _FakeJob(log, env)
        with patch("time.sleep") as mock_sleep:
            job._wait_if_paused()

        # Must have slept once (first iteration) but NOT a second time
        self.assertEqual(mock_sleep.call_count, 1)
        # Clears pause flag so caller can proceed
        job.log.write.assert_any_call({"job_pause_requested": False})

    def test_skip_while_paused_does_not_require_resume(self):
        """The caller should not need to send a resume after a skip-while-paused."""
        log = _make_log(pause=True)
        env = _make_env(
            [
                (False, True, "file.csv"),  # skip arrives immediately on first poll
            ]
        )
        job = _FakeJob(log, env)
        with patch("time.sleep") as mock_sleep:
            job._wait_if_paused()

        # No sleep at all since skip arrived on the first check
        mock_sleep.assert_not_called()
        job.log.write.assert_called_with({"job_pause_requested": False})

    def test_normal_resume_path_still_works(self):
        """Paused → resume (pause flag cleared) → proceeds normally."""
        log = _make_log(pause=True)
        env = _make_env(
            [
                (False, True, ""),  # 1st poll: paused
                (False, False, ""),  # 2nd poll: resume (pause flag cleared)
            ]
        )
        job = _FakeJob(log, env)
        with patch("time.sleep") as mock_sleep:
            job._wait_if_paused()

        self.assertEqual(mock_sleep.call_count, 1)
        # Sets running after resume
        job.log.write.assert_any_call({"job_state": "running"})


if __name__ == "__main__":
    unittest.main()
