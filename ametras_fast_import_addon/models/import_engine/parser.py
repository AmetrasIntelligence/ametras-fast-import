"""
CSV parsing for the import engine.

Replaces PapaParse (TypeScript) with Python's csv module.
Supports streaming, batched processing, and multiple encodings.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from typing import Callable, Iterator, Optional

from .constants import (
    DEFAULT_DELIMITER, DEFAULT_ENCODING, SUPPORTED_DELIMITERS,
    DELIMITER_DETECTION_SAMPLE_SIZE, FILE_ANALYSIS_SAMPLE_SIZE,
    SAMPLE_ROW_COUNT,
)


@dataclass
class ParsedRow:
    """A single parsed CSV row with its 1-based index."""
    index: int
    data: dict[str, str]


@dataclass
class ParseOptions:
    """CSV parsing options."""
    delimiter: str = DEFAULT_DELIMITER
    encoding: str = DEFAULT_ENCODING
    has_header: bool = True


def _open_file(file_path: str, encoding: str = DEFAULT_ENCODING):
    """Open a CSV file with BOM handling and error tolerance."""
    # utf-8-sig handles UTF-8 BOM automatically
    if encoding in ('utf-8', 'utf-8-sig'):
        return open(file_path, newline='', encoding='utf-8-sig', errors='replace')
    return open(file_path, newline='', encoding=encoding, errors='replace')


def _detect_delimiter(sample: str, preferred: str = '') -> str:
    """
    Auto-detect CSV delimiter from a sample of the file.

    Counts occurrences of common delimiters in the first line and returns
    the one with the most occurrences. Returns DEFAULT_DELIMITER if none found.
    """
    if preferred:
        return preferred
    first_line = sample.split('\n', 1)[0]
    candidates = {d: 0 for d in SUPPORTED_DELIMITERS}
    for char in first_line:
        if char in candidates:
            candidates[char] += 1
    if not any(candidates.values()):
        return DEFAULT_DELIMITER
    return max(candidates, key=candidates.get)


def parse_csv_file(
    file_path: str,
    options: Optional[ParseOptions] = None,
) -> Iterator[ParsedRow]:
    """
    Stream rows from a CSV file path.

    Used in subprocess mode (Electron) where Python reads files directly.
    Yields ParsedRow instances with 1-based index.
    """
    opts = options or ParseOptions()

    with _open_file(file_path, opts.encoding) as f:
        if not opts.delimiter:
            sample = f.read(DELIMITER_DETECTION_SAMPLE_SIZE)
            detected = _detect_delimiter(sample)
            f.seek(0)
        else:
            detected = opts.delimiter

        if opts.has_header:
            reader = csv.DictReader(f, delimiter=detected)
            for idx, row in enumerate(reader, start=1):
                data = {k.strip(): v for k, v in row.items() if k is not None}
                if not any(v for v in data.values() if v is not None and v != ''):
                    continue  # skip blank/empty lines (mirrors PapaParse skipEmptyLines)
                yield ParsedRow(index=idx, data=data)
        else:
            reader = csv.reader(f, delimiter=detected)
            for idx, row in enumerate(reader, start=1):
                if not any(v for v in row if v):
                    continue  # skip blank/empty lines
                data = {str(i): v for i, v in enumerate(row)}
                yield ParsedRow(index=idx, data=data)


def parse_csv_string(
    content: str,
    options: Optional[ParseOptions] = None,
) -> Iterator[ParsedRow]:
    """
    Stream rows from a CSV string.

    Used in addon mode when CSV content is already in memory.
    """
    opts = options or ParseOptions()

    delimiter = opts.delimiter
    if not delimiter:
        delimiter = _detect_delimiter(content[:DELIMITER_DETECTION_SAMPLE_SIZE])

    if opts.has_header:
        reader = csv.DictReader(io.StringIO(content), delimiter=delimiter)
        for idx, row in enumerate(reader, start=1):
            data = {k.strip(): v for k, v in row.items() if k is not None}
            if not any(v for v in data.values() if v is not None and v != ''):
                continue  # skip blank/empty lines
            yield ParsedRow(index=idx, data=data)
    else:
        reader = csv.reader(io.StringIO(content), delimiter=delimiter)
        for idx, row in enumerate(reader, start=1):
            if not any(v for v in row if v):
                continue  # skip blank/empty lines
            data = {str(i): v for i, v in enumerate(row)}
            yield ParsedRow(index=idx, data=data)


def parse_csv_batched(
    source: Iterator[ParsedRow],
    batch_size: int,
    on_batch: Optional[Callable] = None,
) -> list:
    """
    Collect rows from a source into batches.

    Args:
        source: Iterator of ParsedRow (from parse_csv_file or parse_csv_string)
        batch_size: Number of rows per batch
        on_batch: Optional callback called with each batch (list of ParsedRow)

    Returns:
        List of all results from on_batch calls, or list of batches if no callback
    """
    batch: list[ParsedRow] = []
    results = []

    for row in source:
        batch.append(row)
        if len(batch) >= batch_size:
            if on_batch:
                result = on_batch(batch)
                if result is not None:
                    results.append(result)
            else:
                results.append(batch)
            batch = []

    if batch:
        if on_batch:
            result = on_batch(batch)
            if result is not None:
                results.append(result)
        else:
            results.append(batch)

    return results


def count_csv_rows(
    file_path: str,
    encoding: str = DEFAULT_ENCODING,
    has_header: bool = True,
) -> int:
    """
    Count data rows in a CSV file efficiently without parsing all fields.

    Skips blank lines (lines that are empty or contain only whitespace/commas)
    to stay consistent with parse_csv_file's skipEmptyLines behaviour.
    Subtracts 1 for the header row if has_header is True.
    """
    count = 0
    with _open_file(file_path, encoding) as f:
        for line in f:
            if line.strip():
                count += 1
    if has_header and count > 0:
        count -= 1
    return count


def analyze_csv(
    content: str,
    encoding: str = DEFAULT_ENCODING,
    delimiter: str = '',
) -> dict:
    """
    Analyze CSV content: detect headers, delimiter, sample rows, row count.

    Replaces the client-side analyzeCSV() function from csvParser.ts.
    Used by ImportView for file preview before starting import.

    Args:
        content: CSV file content as string
        encoding: File encoding (for metadata only — content is already decoded)
        delimiter: Preferred delimiter (auto-detected if empty)

    Returns:
        dict with headers, rowCount, sampleRows, delimiter, hasIdColumn, hasDotIdColumn
    """
    detected = _detect_delimiter(content[:DELIMITER_DETECTION_SAMPLE_SIZE], delimiter)
    options = ParseOptions(delimiter=detected, encoding=encoding, has_header=True)
    rows = list(parse_csv_string(content, options))

    headers = list(rows[0].data.keys()) if rows else []
    sample = [r.data for r in rows[:SAMPLE_ROW_COUNT]]

    return {
        'headers': headers,
        'rowCount': len(rows),
        'sampleRows': sample,
        'delimiter': detected,
        'hasIdColumn': 'id' in headers,
        'hasDotIdColumn': '.id' in headers,
    }


def analyze_csv_file(
    file_path: str,
    encoding: str = DEFAULT_ENCODING,
    delimiter: str = '',
) -> dict:
    """
    Analyze a CSV file from disk (Electron subprocess mode).
    Only reads a sample for headers/delimiter/preview — doesn't load entire file.
    Row count uses efficient line counting.
    """
    with _open_file(file_path, encoding) as f:
        sample = f.read(FILE_ANALYSIS_SAMPLE_SIZE)

    detected = _detect_delimiter(sample[:DELIMITER_DETECTION_SAMPLE_SIZE], delimiter)
    options = ParseOptions(delimiter=detected, encoding=encoding, has_header=True)
    sample_rows = list(parse_csv_string(sample, options))

    headers = list(sample_rows[0].data.keys()) if sample_rows else []
    preview = [r.data for r in sample_rows[:SAMPLE_ROW_COUNT]]

    row_count = count_csv_rows(file_path, encoding, has_header=True)

    return {
        'headers': headers,
        'rowCount': row_count,
        'sampleRows': preview,
        'delimiter': detected,
        'hasIdColumn': 'id' in headers,
        'hasDotIdColumn': '.id' in headers,
    }


def extract_rows_by_index(
    file_path: str,
    indices: set[int],
    options: Optional[ParseOptions] = None,
) -> list[ParsedRow]:
    """
    Extract specific rows by their 1-based index.

    Used for resume: only re-process rows that failed or weren't processed.
    """
    result = []
    for row in parse_csv_file(file_path, options):
        if row.index in indices:
            result.append(row)
    return result
