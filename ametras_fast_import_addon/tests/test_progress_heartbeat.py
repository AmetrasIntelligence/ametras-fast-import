"""
Tests for the heartbeat the JSON-lines reporter sends while a batch runs.

The client cancels a run that reports nothing for a while. Progress lines come
only when a whole batch is done, so the reporter sends a heartbeat from the
rows it sees in between, at most once per HEARTBEAT_INTERVAL_SECONDS.

Run with: python3 ametras_fast_import_addon/tests/test_progress_heartbeat.py
"""
import io
import json
import os
import sys
import unittest

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.backend import FieldInfo, OdooBackend
from import_engine.constants import HEARTBEAT_INTERVAL_SECONDS, PROGRESS_TYPE_HEARTBEAT
from import_engine.importer import ImportConfig, Importer
from import_engine.parser import ParsedRow
from import_engine.progress import JsonLinesReporter


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def _lines(stream):
    return [json.loads(line) for line in stream.getvalue().splitlines() if line]


def _heartbeats(stream):
    return [m for m in _lines(stream) if m["type"] == PROGRESS_TYPE_HEARTBEAT]


class TestReporterHeartbeat(unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.stream = io.StringIO()
        self.clock = FakeClock()
        self.reporter = JsonLinesReporter(self.stream, clock=self.clock)

    def test_first_row_sends_a_heartbeat(self):
        self.reporter.row_completed(1, True)
        beats = _heartbeats(self.stream)
        self.assertEqual(
            len(beats),
            1,
            msg="The first finished row must tell the client the run lives",
        )
        self.assertEqual(beats[0]["rows"], 1)

    def test_rows_within_the_interval_send_no_further_heartbeat(self):
        # 60 rows over 6 s: the first row and the first one after the interval
        for row in range(1, 61):
            self.clock.now += 0.1
            self.reporter.row_completed(row, True)
        beats = _heartbeats(self.stream)
        self.assertEqual(
            len(beats),
            2,
            msg=f"60 rows over 6 s must send 2 heartbeats, sent {len(beats)}",
        )

    def test_heartbeat_after_the_interval_counts_all_rows(self):
        self.reporter.row_completed(1, True)
        self.clock.now += HEARTBEAT_INTERVAL_SECONDS / 2
        self.reporter.row_completed(2, False, "Simulated row error")
        self.clock.now += HEARTBEAT_INTERVAL_SECONDS
        self.reporter.row_completed(3, True)
        beats = _heartbeats(self.stream)
        self.assertEqual([b["rows"] for b in beats], [1, 3])

    def test_heartbeat_is_not_a_progress_line(self):
        self.reporter.row_completed(1, True)
        types = [m["type"] for m in _lines(self.stream)]
        self.assertNotIn(
            "progress",
            types,
            msg="A heartbeat must not change the row counts the client shows",
        )


class FakeRowBackend(OdooBackend):
    """Backend whose create() advances the clock like a slow server."""

    def __init__(self, clock, seconds_per_row):
        self.clock = clock
        self.seconds_per_row = seconds_per_row
        self.next_id = 100

    def get_field_info(self, model):
        return {"name": FieldInfo(name="name", type="char")}

    def search(self, model, domain, fields=None, limit=None):
        return []

    def search_read(self, model, domain, fields=None, limit=None):
        return []

    def create(self, model, vals):  # pylint: disable=method-required-super
        self.clock.now += self.seconds_per_row
        self.next_id += 1
        return self.next_id

    def write(self, model, ids, vals):  # pylint: disable=method-required-super
        self.clock.now += self.seconds_per_row
        return True

    def execute(self, model, method, *args, **kwargs):
        return None

    def browse_exists(self, model, record_id):
        return True


class TestHeartbeatDuringSlowBatch(unittest.TestCase):
    def test_slow_batch_sends_heartbeats_before_it_is_done(self):
        """A batch of 50 rows at 2 s each runs 100 s; heartbeats must keep
        coming while it runs so the client does not cancel it."""
        stream = io.StringIO()
        clock = FakeClock()
        reporter = JsonLinesReporter(stream, clock=clock)
        backend = FakeRowBackend(clock, seconds_per_row=2.0)
        importer = Importer(
            backend,
            ImportConfig(model="product.template", field_mappings={"name": "name"}),
            reporter=reporter,
        )
        rows = [ParsedRow(index=i, data={"name": f"Product {i}"}) for i in range(1, 51)]

        results = importer.import_rows(rows)

        self.assertTrue(
            all(r.ok for r in results),
            msg=f"Every row must be created: {[r.error for r in results if not r.ok]}",
        )
        beats = _heartbeats(stream)
        self.assertGreaterEqual(
            len(beats),
            100 // (HEARTBEAT_INTERVAL_SECONDS * 2),
            msg="A 100 s batch must send heartbeats all along, not only at its end",
        )
        gaps = [b2["rows"] - b1["rows"] for b1, b2 in zip(beats, beats[1:])]
        self.assertTrue(
            all(gap * 2.0 <= HEARTBEAT_INTERVAL_SECONDS + 2.0 for gap in gaps),
            msg=f"Heartbeats must come about every {HEARTBEAT_INTERVAL_SECONDS} s,"
            f" row gaps were {gaps}",
        )


sys.path.insert(0, os.path.dirname(__file__))
from test_importer_batch_write import FakeLoadBackend  # noqa: E402


class SlowStepBackend(FakeLoadBackend):
    """FakeLoadBackend whose batched writes take 30 s each."""

    def __init__(self, clock):
        super().__init__()
        self.clock = clock

    def create_many(self, model, vals_list):
        if model != "ir.model.data":
            self.clock.now += 30.0
        return super().create_many(model, vals_list)

    def load(self, model, fields, rows, context):
        self.clock.now += 30.0
        return super().load(model, fields, rows, context)


class TestHeartbeatDuringSlowBatchedWrite(unittest.TestCase):
    def test_each_written_step_sends_a_heartbeat_before_the_batch_ends(self):
        """With "Write in batches" a batch is written in steps; rows naming one
        record twice cut a step. Each slow step must show the run is alive."""
        clock = FakeClock()

        stream = io.StringIO()
        reporter = JsonLinesReporter(stream, clock=clock)
        importer = Importer(
            SlowStepBackend(clock),
            ImportConfig(
                model="product.template",
                field_mappings={},
                batch_size=50,
                batch_write=True,
                use_external_id=True,
            ),
            reporter=reporter,
        )
        # p1, p1, p2, p2, p3, p3: three steps of 30 s or more each
        rows = [
            ParsedRow(
                index=i + 1,
                data={"__external_id__": f"p{i // 2 + 1}", "name": f"Product {i}"},
            )
            for i in range(6)
        ]

        results = importer.import_rows(rows)

        self.assertTrue(
            all(r.ok for r in results),
            msg=f"Every row must be written: {[r.error for r in results if not r.ok]}",
        )
        beats = _heartbeats(stream)
        self.assertGreaterEqual(
            len(beats),
            3,
            msg=f"Each slow step must send a heartbeat, got {len(beats)}",
        )
        self.assertLess(
            beats[0]["rows"],
            len(rows),
            msg="The first heartbeat must come before the whole batch is written",
        )


if __name__ == "__main__":
    unittest.main()
