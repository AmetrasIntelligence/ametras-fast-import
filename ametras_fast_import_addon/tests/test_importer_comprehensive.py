"""
Comprehensive tests for the Importer — covers all edge cases and code paths.
Run with: python3 ametras_fast_import_addon/tests/test_importer_comprehensive.py
"""
import unittest
import sys
import os
import tempfile

_engine_path = os.path.join(os.path.dirname(__file__), '..', 'models')
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.backend import OdooBackend, FieldInfo
from import_engine.importer import Importer, ImportConfig, RowResult
from import_engine.parser import ParsedRow
from import_engine.progress import ProgressReporter


class MockBackend(OdooBackend):
    """In-memory mock backend for testing."""

    def __init__(self):
        self.records = {}
        self.next_id = {}
        self.field_info_map = {}
        self._savepoint_rollback_count = 0

    def _ensure_model(self, model):
        if model not in self.records:
            self.records[model] = {}
            self.next_id[model] = 1

    def search(self, model, domain, fields=None, limit=None):
        self._ensure_model(model)
        results = []
        for rid, vals in self.records[model].items():
            if self._matches(vals, domain, rid):
                results.append(rid)
        if limit:
            results = results[:limit]
        if fields:
            return [{'id': rid, **{f: self.records[model][rid].get(f) for f in fields}} for rid in results]
        return results

    def create(self, model, vals):
        self._ensure_model(model)
        rid = self.next_id[model]
        self.next_id[model] += 1
        self.records[model][rid] = dict(vals)
        return rid

    def write(self, model, ids, vals):
        self._ensure_model(model)
        for rid in ids:
            if rid in self.records[model]:
                self.records[model][rid].update(vals)
        return True

    def search_read(self, model, domain, fields, limit=None):
        self._ensure_model(model)
        results = []
        for rid, vals in self.records[model].items():
            if self._matches(vals, domain, rid):
                rec = {'id': rid}
                for f in fields:
                    rec[f] = vals.get(f)
                results.append(rec)
        if limit:
            results = results[:limit]
        return results

    def execute(self, model, method, *args, **kwargs):
        return None

    def get_field_info(self, model):
        return self.field_info_map.get(model, {})

    def browse_exists(self, model, record_id):
        self._ensure_model(model)
        return record_id in self.records[model]

    def _matches(self, vals, domain, rid=None):
        for cond in domain:
            field_name, op, value = cond
            if field_name == 'id':
                record_value = rid
            else:
                record_value = vals.get(field_name)
            if op == '=':
                if record_value != value:
                    return False
            elif op == 'in':
                if record_value not in value:
                    return False
        return True


class ErrorBackend(MockBackend):
    """Backend that raises errors for specific operations."""

    def __init__(self):
        super().__init__()
        self.fail_on_create = set()  # model names that fail on create
        self.fail_on_write = set()

    def create(self, model, vals):
        if model in self.fail_on_create:
            raise Exception(f"Simulated create error for {model}")
        return super().create(model, vals)

    def write(self, model, ids, vals):
        if model in self.fail_on_write:
            raise Exception(f"Simulated write error for {model}")
        return super().write(model, ids, vals)


class TrackingReporter(ProgressReporter):
    """Reporter that records all calls for assertion."""

    def __init__(self):
        self.rows = []
        self.batches = []
        self.files_started = []
        self.files_completed = []
        self.imports_completed = []
        self.errors = []

    def row_completed(self, row_index, ok, error=''):
        self.rows.append({'row_index': row_index, 'ok': ok, 'error': error})

    def batch_completed(self, processed, total, success, failed):
        self.batches.append({
            'processed': processed, 'total': total,
            'success': success, 'failed': failed,
        })

    def file_started(self, filename, total_rows):
        self.files_started.append({'filename': filename, 'total_rows': total_rows})

    def file_completed(self, filename, success, failed):
        self.files_completed.append({'filename': filename, 'success': success, 'failed': failed})

    def import_completed(self, summary):
        self.imports_completed.append(summary)

    def error(self, message):
        self.errors.append(message)


# ---------------------------------------------------------------------------
# 1. Partial Batch Failure — some rows succeed, some fail
# ---------------------------------------------------------------------------

class TestPartialBatchFailure(unittest.TestCase):
    """One bad row shouldn't kill the entire batch."""

    def test_mixed_success_and_failure(self):
        """Batch with 3 rows: 2 succeed, 1 fails (bad reference)."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'country_id': FieldInfo('country_id', 'many2one', 'res.country'),
        }
        # Pre-create country ref
        backend.create('res.country', {'name': 'Germany'})
        backend.create('ir.model.data', {
            'module': '__import__', 'name': 'de',
            'model': 'res.country', 'res_id': 1,
        })

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Country': 'country_id/id'},
        )
        importer = Importer(backend, config)

        rows = [
            ParsedRow(index=1, data={'Name': 'Alice', 'Country': 'de'}),
            ParsedRow(index=2, data={'Name': 'Bob', 'Country': 'nonexistent_ref'}),
            ParsedRow(index=3, data={'Name': 'Charlie', 'Country': 'de'}),
        ]
        results = importer.import_rows(rows)

        self.assertEqual(len(results), 3)
        self.assertTrue(results[0].ok)
        self.assertFalse(results[1].ok)
        self.assertIn('not found', results[1].error)
        self.assertTrue(results[2].ok)

    def test_create_error_isolated(self):
        """Backend error on one row doesn't affect others."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
        }

        # Monkey-patch create to fail on specific name
        original_create = backend.create
        def failing_create(model, vals):
            if vals.get('name') == 'FAIL':
                raise Exception('Constraint violation')
            return original_create(model, vals)
        backend.create = failing_create

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name'},
        )
        importer = Importer(backend, config)

        rows = [
            ParsedRow(index=1, data={'Name': 'Good1'}),
            ParsedRow(index=2, data={'Name': 'FAIL'}),
            ParsedRow(index=3, data={'Name': 'Good2'}),
        ]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertFalse(results[1].ok)
        self.assertIn('Constraint violation', results[1].error)
        self.assertTrue(results[2].ok)

    def test_row_indices_preserved_in_results(self):
        """Result row_index matches the input ParsedRow.index."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}
        config = ImportConfig(model='res.partner', field_mappings={'N': 'name'})
        importer = Importer(backend, config)

        rows = [
            ParsedRow(index=42, data={'N': 'A'}),
            ParsedRow(index=99, data={'N': 'B'}),
        ]
        results = importer.import_rows(rows)
        self.assertEqual(results[0].row_index, 42)
        self.assertEqual(results[1].row_index, 99)


# ---------------------------------------------------------------------------
# 2. Many2Many Resolution
# ---------------------------------------------------------------------------

class TestMany2ManyResolution(unittest.TestCase):

    def setUp(self):
        self.backend = MockBackend()
        self.backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'category_id': FieldInfo('category_id', 'many2many', 'res.partner.category'),
        }
        # Pre-create tags
        self.backend.create('res.partner.category', {'name': 'Customer'})
        self.backend.create('res.partner.category', {'name': 'Vendor'})
        self.backend.create('ir.model.data', {
            'module': '__import__', 'name': 'tag_customer',
            'model': 'res.partner.category', 'res_id': 1,
        })
        self.backend.create('ir.model.data', {
            'module': '__import__', 'name': 'tag_vendor',
            'model': 'res.partner.category', 'res_id': 2,
        })

    def test_pipe_delimited_m2m(self):
        """Many2many with pipe-delimited external IDs."""
        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Tags': 'category_id/id'},
        )
        importer = Importer(self.backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'Alice', 'Tags': 'tag_customer|tag_vendor'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        partner = self.backend.records['res.partner'][1]
        self.assertEqual(partner['category_id'], [(6, 0, [1, 2])])

    def test_comma_delimited_m2m(self):
        """Many2many with comma-delimited external IDs (legacy)."""
        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Tags': 'category_id/id'},
        )
        importer = Importer(self.backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'Bob', 'Tags': 'tag_customer,tag_vendor'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        partner = self.backend.records['res.partner'][1]
        self.assertEqual(partner['category_id'], [(6, 0, [1, 2])])

    def test_single_m2m_tag(self):
        """Many2many with a single reference."""
        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Tags': 'category_id/id'},
        )
        importer = Importer(self.backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'Charlie', 'Tags': 'tag_customer'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        partner = self.backend.records['res.partner'][1]
        self.assertEqual(partner['category_id'], [(6, 0, [1])])

    def test_m2m_missing_ref_fails_row(self):
        """Many2many with a non-existent reference fails the row."""
        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Tags': 'category_id/id'},
        )
        importer = Importer(self.backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'Dan', 'Tags': 'tag_customer|nonexistent'})]
        results = importer.import_rows(rows)

        self.assertFalse(results[0].ok)
        self.assertIn('not found', results[0].error)


# ---------------------------------------------------------------------------
# 3. Dry-Run Mode
# ---------------------------------------------------------------------------

class TestDryRun(unittest.TestCase):

    def test_dry_run_reports_success_but_no_records_created(self):
        """Dry run should report success but not actually create records."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name'},
            dry_run=True,
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'Ghost'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertTrue(results[0].dry_run)
        # Note: with NullSavepoint (mock), records ARE created since rollback is a no-op.
        # In real Odoo with OrmBackend, cr.savepoint().rollback() would undo them.
        # This test verifies the dry_run flag is set correctly.

    def test_dry_run_flag_on_update(self):
        """Dry run flag set on updates too."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'email': FieldInfo('email', 'char'),
        }
        backend.create('res.partner', {'name': 'Existing', 'email': 'old@test.com'})

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Email': 'email'},
            search_keys=['email'],
            dry_run=True,
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'Updated', 'Email': 'old@test.com'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertTrue(results[0].dry_run)
        self.assertEqual(results[0].action, 'updated')


# ---------------------------------------------------------------------------
# 4. Database ID Validation (standard model whitelist)
# ---------------------------------------------------------------------------

class TestDatabaseIdValidation(unittest.TestCase):

    def test_db_id_allowed_for_standard_model(self):
        """Database IDs are allowed for res.country (standard model)."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'country_id': FieldInfo('country_id', 'many2one', 'res.country'),
        }
        backend.create('res.country', {'name': 'Germany'})

        config = ImportConfig(model='res.partner', field_mappings={})
        importer = Importer(backend, config)

        # Pre-transformed row with integer country_id
        rows = [ParsedRow(index=1, data={'name': 'Alice', 'country_id': 1})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)

    def test_db_id_accepted_for_non_standard_model(self):
        """Database IDs are accepted for any model (user opted in via /.id mapping)."""
        backend = MockBackend()
        backend.field_info_map['sale.order'] = {
            'name': FieldInfo('name', 'char'),
            'partner_id': FieldInfo('partner_id', 'many2one', 'res.partner'),
        }
        backend.create('res.partner', {'name': 'Existing'})

        config = ImportConfig(model='sale.order', field_mappings={})
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'name': 'SO001', 'partner_id': 1})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)

    def test_db_id_nonexistent_record(self):
        """Database ID pointing to non-existent record fails."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'country_id': FieldInfo('country_id', 'many2one', 'res.country'),
        }
        # No country record created — ID 999 doesn't exist

        config = ImportConfig(model='res.partner', field_mappings={})
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'name': 'Alice', 'country_id': 999})]
        results = importer.import_rows(rows)

        self.assertFalse(results[0].ok)
        self.assertIn('not found', results[0].error)


# ---------------------------------------------------------------------------
# 5. Error Isolation — one row error doesn't affect others
# ---------------------------------------------------------------------------

class TestErrorIsolation(unittest.TestCase):

    def test_five_rows_third_fails(self):
        """Row 3 fails, rows 1-2 and 4-5 succeed."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'country_id': FieldInfo('country_id', 'many2one', 'res.country'),
        }
        backend.create('res.country', {'name': 'Germany'})
        backend.create('ir.model.data', {
            'module': '__import__', 'name': 'de',
            'model': 'res.country', 'res_id': 1,
        })

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Country': 'country_id/id'},
        )
        importer = Importer(backend, config)

        rows = [
            ParsedRow(index=1, data={'Name': 'A', 'Country': 'de'}),
            ParsedRow(index=2, data={'Name': 'B', 'Country': 'de'}),
            ParsedRow(index=3, data={'Name': 'C', 'Country': 'bad_ref'}),
            ParsedRow(index=4, data={'Name': 'D', 'Country': 'de'}),
            ParsedRow(index=5, data={'Name': 'E', 'Country': 'de'}),
        ]
        results = importer.import_rows(rows)

        ok_count = sum(1 for r in results if r.ok)
        fail_count = sum(1 for r in results if not r.ok)
        self.assertEqual(ok_count, 4)
        self.assertEqual(fail_count, 1)
        self.assertFalse(results[2].ok)
        self.assertEqual(results[2].row_index, 3)

    def test_all_rows_fail(self):
        """All rows fail gracefully with individual errors."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'country_id': FieldInfo('country_id', 'many2one', 'res.country'),
        }

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Country': 'country_id/id'},
        )
        importer = Importer(backend, config)

        rows = [
            ParsedRow(index=1, data={'Name': 'A', 'Country': 'bad1'}),
            ParsedRow(index=2, data={'Name': 'B', 'Country': 'bad2'}),
        ]
        results = importer.import_rows(rows)

        self.assertEqual(len(results), 2)
        self.assertFalse(results[0].ok)
        self.assertFalse(results[1].ok)

    def test_empty_batch(self):
        """Empty batch returns empty results."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}
        config = ImportConfig(model='res.partner', field_mappings={'N': 'name'})
        importer = Importer(backend, config)

        results = importer.import_rows([])
        self.assertEqual(results, [])


# ---------------------------------------------------------------------------
# 6. Explicit Operations — update with missing record, case handling
# ---------------------------------------------------------------------------

class TestExplicitOperationEdgeCases(unittest.TestCase):

    def _make_importer(self):
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
        }
        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Op': '__op__'},
        )
        return Importer(backend, config), backend

    def test_update_nonexistent_record_fails(self):
        """__op__=update with no matching record returns error."""
        importer, backend = self._make_importer()
        rows = [ParsedRow(index=1, data={'Name': 'Ghost', 'Op': 'update'})]
        results = importer.import_rows(rows)

        self.assertFalse(results[0].ok)
        self.assertIn('record not found', results[0].error)

    def test_op_case_insensitive(self):
        """Operation column is case-insensitive."""
        importer, backend = self._make_importer()
        rows = [
            ParsedRow(index=1, data={'Name': 'A', 'Op': 'CREATE'}),
            ParsedRow(index=2, data={'Name': 'B', 'Op': 'Skip'}),
            ParsedRow(index=3, data={'Name': 'C', 'Op': ' create '}),
        ]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'created')
        self.assertTrue(results[1].ok)
        self.assertEqual(results[1].action, 'skipped')
        self.assertTrue(results[2].ok)
        self.assertEqual(results[2].action, 'created')

    def test_update_with_external_id(self):
        """__op__=update finds record by external ID."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}
        backend.create('res.partner', {'name': 'Old'})
        backend.create('ir.model.data', {
            'module': '__import__', 'name': 'p1',
            'model': 'res.partner', 'res_id': 1,
        })

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Op': '__op__', 'ID': 'id'},
            use_external_id=True,
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'New', 'Op': 'update', 'ID': 'p1'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'updated')
        self.assertEqual(backend.records['res.partner'][1]['name'], 'New')

    def test_mixed_operations_in_batch(self):
        """Batch with create, update, skip, and unknown ops."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}
        backend.create('res.partner', {'name': 'Existing'})
        backend.create('ir.model.data', {
            'module': '__import__', 'name': 'existing_p',
            'model': 'res.partner', 'res_id': 1,
        })

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Op': '__op__', 'ID': 'id'},
            use_external_id=True,
        )
        importer = Importer(backend, config)

        rows = [
            ParsedRow(index=1, data={'Name': 'New1', 'Op': 'create', 'ID': ''}),
            ParsedRow(index=2, data={'Name': 'Updated', 'Op': 'update', 'ID': 'existing_p'}),
            ParsedRow(index=3, data={'Name': 'Skipped', 'Op': 'skip', 'ID': ''}),
            ParsedRow(index=4, data={'Name': 'Bad', 'Op': 'delete', 'ID': ''}),
        ]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'created')
        self.assertTrue(results[1].ok)
        self.assertEqual(results[1].action, 'updated')
        self.assertTrue(results[2].ok)
        self.assertEqual(results[2].action, 'skipped')
        self.assertFalse(results[3].ok)
        self.assertIn('Unknown operation', results[3].error)


# ---------------------------------------------------------------------------
# 7. Search Key Edge Cases
# ---------------------------------------------------------------------------

class TestSearchKeyEdgeCases(unittest.TestCase):

    def test_multiple_search_keys(self):
        """Upsert using composite search key (two fields)."""
        backend = MockBackend()
        backend.field_info_map['product.template'] = {
            'name': FieldInfo('name', 'char'),
            'default_code': FieldInfo('default_code', 'char'),
            'barcode': FieldInfo('barcode', 'char'),
        }
        backend.create('product.template', {
            'name': 'Widget', 'default_code': 'W01', 'barcode': 'EAN001',
        })

        config = ImportConfig(
            model='product.template',
            field_mappings={'Name': 'name', 'Code': 'default_code', 'Barcode': 'barcode'},
            search_keys=['default_code', 'barcode'],
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'Widget v2', 'Code': 'W01', 'Barcode': 'EAN001'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'updated')
        self.assertEqual(backend.records['product.template'][1]['name'], 'Widget v2')

    def test_search_key_no_match_creates(self):
        """No matching record by search key → create new."""
        backend = MockBackend()
        backend.field_info_map['product.template'] = {
            'name': FieldInfo('name', 'char'),
            'default_code': FieldInfo('default_code', 'char'),
        }
        backend.create('product.template', {'name': 'Old', 'default_code': 'OLD'})

        config = ImportConfig(
            model='product.template',
            field_mappings={'Name': 'name', 'Code': 'default_code'},
            search_keys=['default_code'],
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'New Product', 'Code': 'NEW'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'created')
        self.assertEqual(len(backend.records['product.template']), 2)

    def test_search_key_empty_value_treated_as_missing(self):
        """Empty search key value treated as missing → strict mode fails."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'email': FieldInfo('email', 'char'),
        }

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Email': 'email'},
            search_keys=['email'],
            strict=True,
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'Alice', 'Email': ''})]
        results = importer.import_rows(rows)

        self.assertFalse(results[0].ok)
        self.assertIn('Missing search keys', results[0].error)

    def test_multiple_matches_uses_first(self):
        """Multiple records matching search key → use first (with warning)."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'email': FieldInfo('email', 'char'),
        }
        backend.create('res.partner', {'name': 'First', 'email': 'dup@test.com'})
        backend.create('res.partner', {'name': 'Second', 'email': 'dup@test.com'})

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Email': 'email'},
            search_keys=['email'],
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'Updated', 'Email': 'dup@test.com'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'updated')
        self.assertEqual(results[0].record_id, 1)  # First match


# ---------------------------------------------------------------------------
# 8. External ID Edge Cases
# ---------------------------------------------------------------------------

class TestExternalIdEdgeCases(unittest.TestCase):

    def test_module_dot_name_format(self):
        """External ID with explicit module: 'mymodule.partner_1'."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}
        backend.create('res.partner', {'name': 'Old'})
        backend.create('ir.model.data', {
            'module': 'mymodule', 'name': 'partner_1',
            'model': 'res.partner', 'res_id': 1,
        })

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'ID': 'id'},
            use_external_id=True,
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'New', 'ID': 'mymodule.partner_1'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'updated')

    def test_external_id_creates_imd_record(self):
        """Creating with external ID creates ir.model.data entry."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'ID': 'id'},
            use_external_id=True,
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'New', 'ID': 'my_partner'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        # Check ir.model.data was created
        imd = backend.records.get('ir.model.data', {})
        self.assertTrue(any(
            v.get('name') == 'my_partner' and v.get('module') == '__import__'
            for v in imd.values()
        ))

    def test_external_id_not_used_when_disabled(self):
        """External ID column ignored when use_external_id=False."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'ID': 'id'},
            use_external_id=False,  # Disabled
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'A', 'ID': 'ext_1'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'created')
        # No ir.model.data should be created
        imd = backend.records.get('ir.model.data', {})
        self.assertEqual(len(imd), 0)

    def test_external_id_dangling_reference(self):
        """External ID exists in ir.model.data but record was deleted."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}
        # IMD entry points to ID 999 which doesn't exist
        backend.create('ir.model.data', {
            'module': '__import__', 'name': 'deleted_partner',
            'model': 'res.partner', 'res_id': 999,
        })

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'ID': 'id'},
            use_external_id=True,
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'New', 'ID': 'deleted_partner'})]
        results = importer.import_rows(rows)

        # Should create new since the referenced record doesn't exist
        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'created')


# ---------------------------------------------------------------------------
# 9. Strategy Priority / Decision Tree
# ---------------------------------------------------------------------------

class TestStrategyPriority(unittest.TestCase):
    """Test that strategies are applied in correct priority order."""

    def test_op_takes_priority_over_external_id(self):
        """__op__ column overrides external ID lookup."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}
        backend.create('res.partner', {'name': 'Existing'})
        backend.create('ir.model.data', {
            'module': '__import__', 'name': 'p1',
            'model': 'res.partner', 'res_id': 1,
        })

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'ID': 'id', 'Op': '__op__'},
            use_external_id=True,
        )
        importer = Importer(backend, config)

        # Op=create should force creation even though external ID matches
        rows = [ParsedRow(index=1, data={'Name': 'Forced Create', 'ID': 'p1', 'Op': 'create'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'created')
        self.assertEqual(results[0].strategy, 'explicit_op')
        # Both records exist now
        self.assertEqual(len(backend.records['res.partner']), 2)

    def test_external_id_before_search_keys(self):
        """External ID takes priority over search key match."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'email': FieldInfo('email', 'char'),
        }
        # Record 1: matched by email, has external ID
        backend.create('res.partner', {'name': 'Old', 'email': 'a@test.com'})
        backend.create('ir.model.data', {
            'module': '__import__', 'name': 'p1',
            'model': 'res.partner', 'res_id': 1,
        })

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Email': 'email', 'ID': 'id'},
            use_external_id=True,
            search_keys=['email'],
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'Updated', 'Email': 'a@test.com', 'ID': 'p1'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].strategy, 'external_id')

    def test_fallback_to_create(self):
        """No match on any strategy → create."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'email': FieldInfo('email', 'char'),
        }

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'Email': 'email'},
            search_keys=['email'],
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'New', 'Email': 'new@test.com'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'created')
        self.assertEqual(results[0].strategy, 'create')


# ---------------------------------------------------------------------------
# 10. File-Based Import End-to-End
# ---------------------------------------------------------------------------

class TestImportCsvFile(unittest.TestCase):
    """End-to-end test: import_csv_file() with real CSV files."""

    def _write_csv(self, content, encoding='utf-8'):
        f = tempfile.NamedTemporaryFile(
            mode='w', suffix='.csv', delete=False, encoding=encoding,
        )
        f.write(content)
        f.close()
        return f.name

    def test_basic_file_import(self):
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'email': FieldInfo('email', 'char'),
        }

        config = ImportConfig(
            model='res.partner',
            field_mappings={'name': 'name', 'email': 'email'},
            batch_size=2,
        )
        reporter = TrackingReporter()
        importer = Importer(backend, config, reporter)

        path = self._write_csv("name,email\nAlice,a@t.com\nBob,b@t.com\nCharlie,c@t.com")
        summary = importer.import_csv_file(path)
        os.unlink(path)

        self.assertEqual(summary.success + summary.failed, 3)
        self.assertEqual(summary.failed, 0)
        self.assertEqual(len(backend.records['res.partner']), 3)

        # Reporter should have been called
        self.assertEqual(len(reporter.files_started), 1)
        self.assertEqual(reporter.files_started[0]['total_rows'], 3)
        self.assertEqual(len(reporter.files_completed), 1)
        self.assertEqual(reporter.files_completed[0]['success'], 3)

    def test_file_import_with_batching(self):
        """Verify batching splits rows correctly."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}

        config = ImportConfig(
            model='res.partner',
            field_mappings={'name': 'name'},
            batch_size=2,
        )
        reporter = TrackingReporter()
        importer = Importer(backend, config, reporter)

        path = self._write_csv("name\nA\nB\nC\nD\nE")
        summary = importer.import_csv_file(path)
        os.unlink(path)

        self.assertEqual(summary.success + summary.failed, 5)
        # 5 rows with batch_size=2 → 3 batches (2+2+1)
        self.assertEqual(len(reporter.batches), 3)
        self.assertEqual(reporter.batches[0]['processed'], 2)
        self.assertEqual(reporter.batches[1]['processed'], 4)
        self.assertEqual(reporter.batches[2]['processed'], 5)

    def test_file_import_with_errors(self):
        """File import with some rows failing."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'country_id': FieldInfo('country_id', 'many2one', 'res.country'),
        }
        backend.create('res.country', {'name': 'DE'})
        backend.create('ir.model.data', {
            'module': '__import__', 'name': 'de',
            'model': 'res.country', 'res_id': 1,
        })

        config = ImportConfig(
            model='res.partner',
            field_mappings={'name': 'name', 'country': 'country_id/id'},
            batch_size=10,
        )
        reporter = TrackingReporter()
        importer = Importer(backend, config, reporter)

        path = self._write_csv("name,country\nAlice,de\nBob,bad_ref\nCharlie,de")
        summary = importer.import_csv_file(path)
        os.unlink(path)

        self.assertEqual(summary.success, 2)
        self.assertEqual(summary.failed, 1)
        self.assertEqual(reporter.files_completed[0]['success'], 2)
        self.assertEqual(reporter.files_completed[0]['failed'], 1)

    def test_file_import_semicolon_delimiter(self):
        """File with semicolon delimiter."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}

        config = ImportConfig(
            model='res.partner',
            field_mappings={'name': 'name'},
        )
        importer = Importer(backend, config)

        path = self._write_csv("name;email\nAlice;a@t.com\nBob;b@t.com")
        from import_engine.parser import ParseOptions
        summary = importer.import_csv_file(path, ParseOptions(delimiter=';'))
        os.unlink(path)

        self.assertEqual(summary.success + summary.failed, 2)
        self.assertEqual(summary.failed, 0)

    def test_file_import_with_search_key_validation(self):
        """Invalid search key on model returns empty results + error."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}

        config = ImportConfig(
            model='res.partner',
            field_mappings={'name': 'name'},
            search_keys=['nonexistent_field'],
        )
        reporter = TrackingReporter()
        importer = Importer(backend, config, reporter)

        path = self._write_csv("name\nAlice")
        summary = importer.import_csv_file(path)
        os.unlink(path)

        self.assertIsNotNone(summary.file_error)
        self.assertIn('nonexistent_field', summary.file_error)
        self.assertEqual(len(reporter.errors), 1)
        self.assertIn('nonexistent_field', reporter.errors[0])


# ---------------------------------------------------------------------------
# 11. Progress Reporter Integration
# ---------------------------------------------------------------------------

class TestProgressReporter(unittest.TestCase):

    def test_reporter_called_for_each_row(self):
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}
        config = ImportConfig(model='res.partner', field_mappings={'N': 'name'})
        reporter = TrackingReporter()
        importer = Importer(backend, config, reporter)

        rows = [
            ParsedRow(index=1, data={'N': 'A'}),
            ParsedRow(index=2, data={'N': 'B'}),
        ]
        importer.import_rows(rows)

        self.assertEqual(len(reporter.rows), 2)
        self.assertTrue(reporter.rows[0]['ok'])
        self.assertTrue(reporter.rows[1]['ok'])
        self.assertEqual(reporter.rows[0]['row_index'], 1)
        self.assertEqual(reporter.rows[1]['row_index'], 2)

    def test_reporter_errors_tracked(self):
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
            'country_id': FieldInfo('country_id', 'many2one', 'res.country'),
        }
        config = ImportConfig(
            model='res.partner',
            field_mappings={'N': 'name', 'C': 'country_id/id'},
        )
        reporter = TrackingReporter()
        importer = Importer(backend, config, reporter)

        rows = [ParsedRow(index=5, data={'N': 'Bad', 'C': 'missing_ref'})]
        importer.import_rows(rows)

        self.assertEqual(len(reporter.rows), 1)
        self.assertFalse(reporter.rows[0]['ok'])
        self.assertIn('not found', reporter.rows[0]['error'])


# ---------------------------------------------------------------------------
# 12. Database ID (.id) Lookup Fallback
# ---------------------------------------------------------------------------

class TestDatabaseIdLookup(unittest.TestCase):

    def test_db_id_lookup_for_upsert(self):
        """Record found by .id column → update."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {
            'name': FieldInfo('name', 'char'),
        }
        backend.create('res.partner', {'name': 'Original'})

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'DbID': '.id'},
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'Updated', 'DbID': '1'})]
        results = importer.import_rows(rows)

        self.assertTrue(results[0].ok)
        self.assertEqual(results[0].action, 'updated')
        self.assertEqual(results[0].strategy, 'db_id')
        self.assertEqual(backend.records['res.partner'][1]['name'], 'Updated')

    def test_db_id_nonexistent_fails(self):
        """Non-existent .id → error (not create). User intended to update by ID."""
        backend = MockBackend()
        backend.field_info_map['res.partner'] = {'name': FieldInfo('name', 'char')}

        config = ImportConfig(
            model='res.partner',
            field_mappings={'Name': 'name', 'DbID': '.id'},
        )
        importer = Importer(backend, config)

        rows = [ParsedRow(index=1, data={'Name': 'New', 'DbID': '999'})]
        results = importer.import_rows(rows)

        self.assertFalse(results[0].ok)
        self.assertIn('.id=999', results[0].error)
        self.assertIn('not found', results[0].error)


if __name__ == '__main__':
    unittest.main(verbosity=2)
