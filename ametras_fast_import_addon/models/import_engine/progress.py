"""
Progress reporting for the import engine.

Two implementations:
- NullReporter: No-op (addon mode — Vue handles progress via HTTP responses)
- JsonLinesReporter: Writes JSON lines to stdout (Electron subprocess mode)
"""
import json
import sys
from abc import ABC, abstractmethod
from typing import Optional

from .constants import (
    PROGRESS_TYPE_FILE_START, PROGRESS_TYPE_PROGRESS,
    PROGRESS_TYPE_FILE_DONE, PROGRESS_TYPE_DONE, PROGRESS_TYPE_ERROR,
)


class ProgressReporter(ABC):
    """Abstract progress reporter."""

    @abstractmethod
    def row_completed(self, row_index: int, ok: bool, error: str = '') -> None:
        """Called after each row is processed."""

    @abstractmethod
    def batch_completed(self, processed: int, total: int,
                        success: int, failed: int) -> None:
        """Called after each batch is processed."""

    @abstractmethod
    def file_started(self, filename: str, total_rows: int) -> None:
        """Called when a file starts processing."""

    @abstractmethod
    def file_completed(self, filename: str, success: int, failed: int) -> None:
        """Called when a file finishes processing."""

    @abstractmethod
    def import_completed(self, summary: dict) -> None:
        """Called when the entire import is done."""

    @abstractmethod
    def error(self, message: str) -> None:
        """Called on fatal errors."""


class NullReporter(ProgressReporter):
    """No-op reporter for addon mode (Vue handles progress via HTTP)."""

    def row_completed(self, row_index: int, ok: bool, error: str = '') -> None:
        pass

    def batch_completed(self, processed: int, total: int,
                        success: int, failed: int) -> None:
        pass

    def file_started(self, filename: str, total_rows: int) -> None:
        pass

    def file_completed(self, filename: str, success: int, failed: int) -> None:
        pass

    def import_completed(self, summary: dict) -> None:
        pass

    def error(self, message: str) -> None:
        pass


class JsonLinesReporter(ProgressReporter):
    """
    Reports progress as JSON lines to stdout.

    Used in Electron subprocess mode. Electron reads stdout line-by-line
    and forwards to Vue via IPC events.

    Protocol:
        {"type": "file_start", "filename": "...", "total_rows": N}
        {"type": "progress", "processed": N, "total": N, "success": N, "failed": N}
        {"type": "file_done", "filename": "...", "success": N, "failed": N}
        {"type": "done", "success": N, "failed": N, "errors": [...]}
        {"type": "error", "message": "..."}
    """

    def __init__(self, stream: Optional[object] = None):
        self._stream = stream or sys.stdout

    def _emit(self, data: dict) -> None:
        self._stream.write(json.dumps(data, ensure_ascii=False) + '\n')
        self._stream.flush()

    def row_completed(self, row_index: int, ok: bool, error: str = '') -> None:
        pass  # Too noisy per-row; batch reporting is sufficient

    def batch_completed(self, processed: int, total: int,
                        success: int, failed: int) -> None:
        self._emit({
            'type': PROGRESS_TYPE_PROGRESS,
            'processed': processed,
            'total': total,
            'success': success,
            'failed': failed,
        })

    def file_started(self, filename: str, total_rows: int) -> None:
        self._emit({
            'type': PROGRESS_TYPE_FILE_START,
            'filename': filename,
            'total_rows': total_rows,
        })

    def file_completed(self, filename: str, success: int, failed: int) -> None:
        self._emit({
            'type': PROGRESS_TYPE_FILE_DONE,
            'filename': filename,
            'success': success,
            'failed': failed,
        })

    def import_completed(self, summary: dict) -> None:
        self._emit({'type': PROGRESS_TYPE_DONE, **summary})

    def error(self, message: str) -> None:
        self._emit({'type': PROGRESS_TYPE_ERROR, 'message': message})
