"""
CSV parser edge case tests — covers special characters, encoding, and analysis.
Port of edge cases from vue-app/tests/unit/csvParser.test.ts.
Run with: python3 ametras_fast_import_addon/tests/test_parser_edge_cases.py
"""
import unittest
import sys
import os
import tempfile

_engine_path = os.path.join(os.path.dirname(__file__), '..', 'models')
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.parser import (
    ParsedRow, ParseOptions, parse_csv_file, parse_csv_string,
    parse_csv_batched, count_csv_rows, extract_rows_by_index,
    _detect_delimiter,
)


def _write_tmp(content, encoding='utf-8', suffix='.csv'):
    f = tempfile.NamedTemporaryFile(
        mode='wb' if isinstance(content, bytes) else 'w',
        suffix=suffix, delete=False,
        **(dict(encoding=encoding) if isinstance(content, str) else {}),
    )
    f.write(content)
    f.close()
    return f.name


# ---------------------------------------------------------------------------
# Special Characters in Fields
# ---------------------------------------------------------------------------

class TestSpecialCharacters(unittest.TestCase):

    def test_commas_in_quoted_fields(self):
        """Fields with commas must be quoted."""
        csv = 'name,address\n"Acme, Inc.","123 Main St, Suite 4"'
        rows = list(parse_csv_string(csv))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].data['name'], 'Acme, Inc.')
        self.assertEqual(rows[0].data['address'], '123 Main St, Suite 4')

    def test_quotes_in_quoted_fields(self):
        """Embedded quotes are escaped by doubling: "" """
        csv = 'name,desc\n"Widget","He said ""hello"" to me"'
        rows = list(parse_csv_string(csv))
        self.assertEqual(rows[0].data['desc'], 'He said "hello" to me')

    def test_newlines_in_quoted_fields(self):
        """Multi-line fields (embedded newlines)."""
        csv = 'name,notes\n"Alice","Line 1\nLine 2\nLine 3"'
        rows = list(parse_csv_string(csv))
        self.assertEqual(len(rows), 1)
        self.assertIn('\n', rows[0].data['notes'])
        self.assertEqual(rows[0].data['notes'], 'Line 1\nLine 2\nLine 3')

    def test_unicode_characters(self):
        """Unicode characters (German umlauts, CJK, emoji)."""
        csv = 'name,city\nMüller,München\n田中,東京'
        rows = list(parse_csv_string(csv))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0].data['name'], 'Müller')
        self.assertEqual(rows[0].data['city'], 'München')
        self.assertEqual(rows[1].data['name'], '田中')

    def test_empty_fields(self):
        """Empty fields between delimiters."""
        csv = 'a,b,c\n1,,3\n,,\n4,5,6'
        rows = list(parse_csv_string(csv))
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0].data['b'], '')
        self.assertEqual(rows[1].data['a'], '')
        self.assertEqual(rows[1].data['b'], '')
        self.assertEqual(rows[1].data['c'], '')

    def test_semicolons_in_comma_csv(self):
        """Semicolons as data in a comma-delimited file."""
        csv = 'name,formula\nTest,a;b;c'
        rows = list(parse_csv_string(csv))
        self.assertEqual(rows[0].data['formula'], 'a;b;c')

    def test_tabs_in_data(self):
        """Tab characters in comma-delimited data."""
        csv = 'name,desc\nTest,has\ttab'
        rows = list(parse_csv_string(csv))
        self.assertEqual(rows[0].data['desc'], 'has\ttab')

    def test_leading_trailing_spaces_in_values(self):
        """Values with leading/trailing spaces are preserved."""
        csv = 'name,code\n  Alice  ,  A01  '
        rows = list(parse_csv_string(csv))
        self.assertEqual(rows[0].data['name'], '  Alice  ')
        self.assertEqual(rows[0].data['code'], '  A01  ')


# ---------------------------------------------------------------------------
# CSV Without Header Mode
# ---------------------------------------------------------------------------

class TestNoHeaderMode(unittest.TestCase):

    def test_no_header_string(self):
        """Parse CSV without header — columns named by index."""
        csv = 'Alice,alice@test.com\nBob,bob@test.com'
        rows = list(parse_csv_string(csv, ParseOptions(has_header=False)))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0].data['0'], 'Alice')
        self.assertEqual(rows[0].data['1'], 'alice@test.com')

    def test_no_header_file(self):
        """Parse file without header."""
        path = _write_tmp('A,1\nB,2\nC,3')
        rows = list(parse_csv_file(path, ParseOptions(has_header=False)))
        os.unlink(path)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0].data['0'], 'A')
        self.assertEqual(rows[2].data['1'], '3')

    def test_no_header_count_rows(self):
        """count_csv_rows with has_header=False counts all lines."""
        path = _write_tmp('A,1\nB,2\nC,3')
        count = count_csv_rows(path, has_header=False)
        os.unlink(path)
        self.assertEqual(count, 3)


# ---------------------------------------------------------------------------
# Encoding Edge Cases
# ---------------------------------------------------------------------------

class TestEncoding(unittest.TestCase):

    def test_utf8_bom_file(self):
        """UTF-8 with BOM — BOM should not appear in header names."""
        content = '\ufeffname,code\nTest,T01'
        path = _write_tmp(content, encoding='utf-8')
        rows = list(parse_csv_file(path))
        os.unlink(path)
        self.assertIn('name', rows[0].data)
        self.assertNotIn('\ufeff', list(rows[0].data.keys())[0])

    def test_latin1_encoding(self):
        """Latin-1 encoded file with special characters."""
        content = 'name,city\nMüller,München'.encode('latin-1')
        path = _write_tmp(content)
        rows = list(parse_csv_file(path, ParseOptions(encoding='latin-1')))
        os.unlink(path)
        self.assertEqual(rows[0].data['name'], 'Müller')
        self.assertEqual(rows[0].data['city'], 'München')

    def test_cp1252_encoding(self):
        """Windows CP1252 encoding."""
        content = 'name\nTest\u2019s'.encode('cp1252')  # smart quote
        path = _write_tmp(content)
        rows = list(parse_csv_file(path, ParseOptions(encoding='cp1252')))
        os.unlink(path)
        self.assertEqual(rows[0].data['name'], 'Test\u2019s')


# ---------------------------------------------------------------------------
# Delimiter Detection
# ---------------------------------------------------------------------------

class TestDelimiterDetection(unittest.TestCase):

    def test_detect_comma(self):
        self.assertEqual(_detect_delimiter('name,email,phone'), ',')

    def test_detect_semicolon(self):
        self.assertEqual(_detect_delimiter('name;email;phone'), ';')

    def test_detect_tab(self):
        self.assertEqual(_detect_delimiter('name\temail\tphone'), '\t')

    def test_mixed_delimiters_most_wins(self):
        """When multiple delimiters present, most frequent wins."""
        self.assertEqual(_detect_delimiter('a;b;c;d,e'), ';')

    def test_no_delimiters_defaults_comma(self):
        self.assertEqual(_detect_delimiter('single_column'), ',')

    def test_auto_detect_from_file(self):
        """Parser auto-detects delimiter when not specified."""
        path = _write_tmp('name;email\nAlice;a@t.com')
        rows = list(parse_csv_file(path, ParseOptions(delimiter='')))
        os.unlink(path)
        self.assertEqual(rows[0].data['name'], 'Alice')

    def test_auto_detect_tab_from_file(self):
        path = _write_tmp('name\temail\nAlice\ta@t.com')
        rows = list(parse_csv_file(path, ParseOptions(delimiter='')))
        os.unlink(path)
        self.assertEqual(rows[0].data['name'], 'Alice')


# ---------------------------------------------------------------------------
# Batching Edge Cases
# ---------------------------------------------------------------------------

class TestBatchingEdgeCases(unittest.TestCase):

    def test_batch_size_equals_row_count(self):
        """Exact batch size = row count → 1 batch."""
        csv = 'name\n' + '\n'.join(f'row{i}' for i in range(5))
        source = parse_csv_string(csv)
        batches = parse_csv_batched(source, batch_size=5)
        self.assertEqual(len(batches), 1)
        self.assertEqual(len(batches[0]), 5)

    def test_batch_size_larger_than_rows(self):
        """Batch size > row count → 1 batch with all rows."""
        csv = 'name\nA\nB'
        source = parse_csv_string(csv)
        batches = parse_csv_batched(source, batch_size=100)
        self.assertEqual(len(batches), 1)
        self.assertEqual(len(batches[0]), 2)

    def test_batch_size_one(self):
        """Batch size = 1 → each row is its own batch."""
        csv = 'name\nA\nB\nC'
        source = parse_csv_string(csv)
        batches = parse_csv_batched(source, batch_size=1)
        self.assertEqual(len(batches), 3)
        for batch in batches:
            self.assertEqual(len(batch), 1)

    def test_empty_csv(self):
        """Empty CSV (only header) → no batches."""
        csv = 'name\n'
        source = parse_csv_string(csv)
        batches = parse_csv_batched(source, batch_size=10)
        self.assertEqual(len(batches), 0)


# ---------------------------------------------------------------------------
# Row Extraction (Resume)
# ---------------------------------------------------------------------------

class TestRowExtraction(unittest.TestCase):

    def test_extract_first_and_last(self):
        path = _write_tmp('name\nA\nB\nC\nD\nE')
        rows = extract_rows_by_index(path, {1, 5})
        os.unlink(path)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0].data['name'], 'A')
        self.assertEqual(rows[1].data['name'], 'E')

    def test_extract_none_found(self):
        """Requested indices don't exist → empty list."""
        path = _write_tmp('name\nA\nB')
        rows = extract_rows_by_index(path, {99, 100})
        os.unlink(path)
        self.assertEqual(len(rows), 0)

    def test_extract_all(self):
        """Extract all rows."""
        path = _write_tmp('name\nA\nB\nC')
        rows = extract_rows_by_index(path, {1, 2, 3})
        os.unlink(path)
        self.assertEqual(len(rows), 3)

    def test_extract_preserves_order(self):
        """Extracted rows are in file order, not set order."""
        path = _write_tmp('name\nA\nB\nC\nD\nE')
        rows = extract_rows_by_index(path, {5, 2, 4})
        os.unlink(path)
        self.assertEqual([r.index for r in rows], [2, 4, 5])


# ---------------------------------------------------------------------------
# Row Count
# ---------------------------------------------------------------------------

class TestRowCount(unittest.TestCase):

    def test_empty_file(self):
        path = _write_tmp('')
        self.assertEqual(count_csv_rows(path), 0)
        os.unlink(path)

    def test_header_only(self):
        path = _write_tmp('name,email\n')
        self.assertEqual(count_csv_rows(path), 0)
        os.unlink(path)

    def test_large_file(self):
        """Verify row count works on larger files."""
        lines = ['name'] + [f'row{i}' for i in range(1000)]
        path = _write_tmp('\n'.join(lines))
        self.assertEqual(count_csv_rows(path), 1000)
        os.unlink(path)

    def test_windows_line_endings(self):
        """CRLF line endings."""
        content = 'name\r\nA\r\nB\r\nC\r\n'
        path = _write_tmp(content)
        self.assertEqual(count_csv_rows(path), 3)
        os.unlink(path)


# ---------------------------------------------------------------------------
# Header Handling
# ---------------------------------------------------------------------------

class TestHeaderHandling(unittest.TestCase):

    def test_whitespace_in_headers(self):
        """Leading/trailing whitespace stripped from headers."""
        csv = ' name , email , phone \nAlice,a@t.com,555'
        rows = list(parse_csv_string(csv))
        self.assertIn('name', rows[0].data)
        self.assertIn('email', rows[0].data)
        self.assertIn('phone', rows[0].data)

    def test_duplicate_headers(self):
        """Duplicate header names — Python csv module appends suffix."""
        # Python csv.DictReader uses last value for duplicate keys by default
        csv = 'name,name,code\nA,B,C'
        rows = list(parse_csv_string(csv))
        # DictReader handles this — just verify no crash
        self.assertEqual(len(rows), 1)

    def test_empty_header_columns(self):
        """CSV with empty header columns."""
        csv = 'name,,code\nAlice,,A01'
        rows = list(parse_csv_string(csv))
        self.assertEqual(rows[0].data['name'], 'Alice')
        self.assertEqual(rows[0].data['code'], 'A01')


if __name__ == '__main__':
    unittest.main(verbosity=2)
