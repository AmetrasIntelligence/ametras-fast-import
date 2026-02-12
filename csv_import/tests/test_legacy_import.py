"""
Unit tests for legacy import integration.
Run with: python3 development/ametras-addons/csv-client/csv_import/tests/test_legacy_import.py
"""
import csv
import unittest
import sys
import os
import types
from unittest.mock import patch, MagicMock

# --- Mocking Odoo ---
# We use ModuleType to create dummy modules that look like the real thing to the importer
odoo = types.ModuleType('odoo')
odoo.http = types.ModuleType('odoo.http')
odoo.http.Controller = object
odoo.http.route = lambda *a, **k: lambda f: f
odoo.http.request = MagicMock()
odoo.http.Response = MagicMock()
odoo.api = types.ModuleType('odoo.api')
odoo.api.Environment = MagicMock()
odoo.SUPERUSER_ID = 1

sys.modules['odoo'] = odoo
sys.modules['odoo.http'] = odoo.http
sys.modules['odoo.api'] = odoo.api

# Mock the legacy importer utility paths
mock_import_threaded_local = types.ModuleType('import_threaded_local')
mock_import_threaded_local.import_data = MagicMock()
mock_import_threaded_old = types.ModuleType('import_threaded_old')
mock_import_threaded_old.import_data = MagicMock()

sys.modules['odoo.addons'] = types.ModuleType('odoo.addons')
sys.modules['odoo.addons.csv_import'] = types.ModuleType('odoo.addons.csv_import')
sys.modules['odoo.addons.csv_import.legacy_importer'] = types.ModuleType('odoo.addons.csv_import.legacy_importer')
sys.modules['odoo.addons.csv_import.legacy_importer'].import_threaded = mock_import_threaded_local
sys.modules['odoo.addons.ametras_csv_importer'] = types.ModuleType('odoo.addons.ametras_csv_importer')
sys.modules['odoo.addons.ametras_csv_importer.odoo_csv_tools'] = types.ModuleType('odoo.addons.ametras_csv_importer.odoo_csv_tools')
sys.modules['odoo.addons.ametras_csv_importer.odoo_csv_tools.odoo_csv_tools'] = types.ModuleType('odoo.addons.ametras_csv_importer.odoo_csv_tools.odoo_csv_tools')
sys.modules['odoo.addons.ametras_csv_importer.odoo_csv_tools.odoo_csv_tools'].import_threaded = mock_import_threaded_old

# --- Path Setup ---
# Add the module path so we can import the controller
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.join(current_dir, '..'))

# Now we can import the controller
from controllers.import_controller import CSVImportController

class TestLegacyImport(unittest.TestCase):
    def setUp(self):
        self.controller = CSVImportController()
        self.mock_model = MagicMock()
        self.mock_model._name = 'res.partner'
        
        # Reset mocks
        mock_import_threaded_local.import_data.reset_mock()
        mock_import_threaded_old.import_data.reset_mock()
        odoo.http.request.reset_mock()
        odoo.http.request.env = MagicMock()
        odoo.http.request.env.__contains__.return_value = False
        odoo.http.request.env.context = {}
        odoo.http.request.uid = 1

    def test_run_legacy_import_prepares_data(self):
        """Test _run_legacy_import correctly converts dict rows to header/data lists."""
        rows = [
            {'name': 'Partner 1', 'email': 'p1@example.com'},
            {'name': 'Partner 2', 'email': 'p2@example.com'}
        ]
        
        odoo.http.request.env.__getitem__.return_value = self.mock_model
        odoo.http.request.db = 'test_db'
        odoo.http.request.registry = MagicMock()
        odoo.http.request.context = {}
        
        with patch('io.StringIO'):
            result = self.controller._run_legacy_import(
                self.mock_model, rows, dry_run=False, use_external_id=False,
                search_keys=None, strict=False
            )
            
            # Check result format
            self.assertTrue(result['results'][0]['ok'])
            self.assertEqual(len(result['results']), 2)
            
            # Check if import_data was called
            mock_import_threaded_local.import_data.assert_called_once()
            mock_import_threaded_old.import_data.assert_not_called()
            kwargs = mock_import_threaded_local.import_data.call_args[1]
            
            # Check model name
            self.assertEqual(kwargs['model'], 'res.partner')
            
            # Check header (keys of the first row) plus required id column
            self.assertEqual(kwargs['header'][0], 'id')
            self.assertEqual(set(kwargs['header']), {'id', 'name', 'email'})
            
            # Check data (values corresponding to header)
            header = kwargs['header']
            data = kwargs['data']
            self.assertEqual(len(data), 2)
            
            # Verify row values match header
            row1_dict = dict(zip(header, data[0]))
            self.assertEqual(row1_dict['name'], 'Partner 1')
            self.assertEqual(row1_dict['email'], 'p1@example.com')

    def test_odoo_load_wrapper(self):
        """Test the internal odoo_load_wrapper calls the model's load method."""
        rows = [{'name': 'Test'}]
        odoo.http.request.env.__getitem__.return_value = self.mock_model
        
        with patch('io.StringIO'):
            self.controller._run_legacy_import(
                self.mock_model, rows, dry_run=False, use_external_id=False,
                search_keys=None, strict=False
            )
            
            # Get the wrapper function passed to import_data
            kwargs = mock_import_threaded_local.import_data.call_args[1]
            wrapper = kwargs['odoo_kw_method']
            
            # Call the wrapper
            # wrapper(dbname, uid, model, method, args, kwargs=None)
            # args[0] is header, args[1] is lines
            test_header = ['name']
            test_lines = [['Test Partner']]
            
            # Setup mock environment for load()
            cursor_cm = MagicMock()
            cursor_cm.__enter__.return_value = MagicMock()
            cursor_cm.__exit__.return_value = False
            odoo.http.request.env.registry.cursor.return_value = cursor_cm

            mock_env = MagicMock()
            mock_env.__getitem__.return_value = self.mock_model
            odoo.api.Environment.return_value = mock_env
            self.mock_model.load.return_value = {'ids': [1], 'messages': []}
            
            result = wrapper('test_db', 1, 'res.partner', 'load', (test_header, test_lines))
            
            # Verify load was called correctly
            odoo.api.Environment.assert_called_once()
            mock_env.__getitem__.assert_called_once_with('res.partner')
            self.mock_model.load.assert_called_once_with(test_header, test_lines)
            self.assertEqual(result['ids'], [1])

    def test_run_import_calls_legacy_when_flag_set(self):
        """Test run_import redirects to _run_legacy_import when use_legacy=True."""
        rows = [{'name': 'Test'}]
        
        odoo.http.request.env = MagicMock()
        odoo.http.request.env.__getitem__.return_value = self.mock_model
        
        with patch.object(CSVImportController, '_run_legacy_import') as mock_legacy:
            mock_legacy.return_value = {'results': []}
            
            self.controller.run_import(model='res.partner', rows=rows, use_legacy=True)
            
            mock_legacy.assert_called_once_with(self.mock_model, rows, False, False, None, False)

    def test_mapping_requirement_confirmation(self):
        """
        Confirms that the legacy importer expects field names in the 'rows' keys.
        """
        # Given rows with custom keys
        rows = [{'Custom Name Field': 'Value'}]
        
        odoo.http.request.env.__getitem__.return_value = self.mock_model
        odoo.http.request.db = 'test_db'
        odoo.http.request.registry = MagicMock()
        odoo.http.request.context = {}
        
        with patch('io.StringIO'):
            self.controller._run_legacy_import(
                self.mock_model, rows, dry_run=False, use_external_id=False,
                search_keys=None, strict=False
            )
            
            # The header passed to legacy importer will include required id column
            kwargs = mock_import_threaded_local.import_data.call_args[1]
            self.assertEqual(kwargs['header'], ['id', 'Custom Name Field'])
            
            # Conclusion: Mapping is required because legacy importer uses these keys as Odoo field names.

    def test_external_id_header_translation(self):
        rows = [{'__external_id__': 'ext_1', 'name': 'Partner'}]

        odoo.http.request.env.__getitem__.return_value = self.mock_model
        odoo.http.request.db = 'test_db'
        odoo.http.request.registry = MagicMock()

        self.controller._run_legacy_import(
            self.mock_model, rows, dry_run=False, use_external_id=True,
            search_keys=None, strict=False
        )

        kwargs = mock_import_threaded_local.import_data.call_args[1]
        header = kwargs['header']
        data = kwargs['data'][0]
        row_dict = dict(zip(header, data))

        self.assertIn('id', header)
        self.assertNotIn('__external_id__', header)
        self.assertEqual(row_dict['id'], 'ext_1')

    def test_db_id_header_translation(self):
        rows = [{'id': 42, 'name': 'Partner'}]

        odoo.http.request.env.__getitem__.return_value = self.mock_model
        odoo.http.request.db = 'test_db'
        odoo.http.request.registry = MagicMock()

        self.controller._run_legacy_import(
            self.mock_model, rows, dry_run=False, use_external_id=False,
            search_keys=None, strict=False
        )

        kwargs = mock_import_threaded_local.import_data.call_args[1]
        header = kwargs['header']
        data = kwargs['data'][0]
        row_dict = dict(zip(header, data))

        self.assertIn('.id', header)
        self.assertEqual(row_dict['.id'], 42)

    def test_op_column_is_ignored(self):
        rows = [{'__op__': 'skip', 'name': 'Partner'}]

        odoo.http.request.env.__getitem__.return_value = self.mock_model
        odoo.http.request.db = 'test_db'
        odoo.http.request.registry = MagicMock()

        self.controller._run_legacy_import(
            self.mock_model, rows, dry_run=False, use_external_id=False,
            search_keys=None, strict=False
        )

        kwargs = mock_import_threaded_local.import_data.call_args[1]
        self.assertNotIn('__op__', kwargs['header'])

    def test_legacy_results_correlate_with_fail_file(self):
        rows = [
            {'name': 'Partner 1', 'email': 'p1@example.com'},
            {'name': 'Partner 2', 'email': 'p2@example.com'}
        ]

        odoo.http.request.env.__getitem__.return_value = self.mock_model
        odoo.http.request.db = 'test_db'
        odoo.http.request.registry = MagicMock()

        def write_fail_file(**kwargs):
            with open(kwargs['fail_file'], 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f, delimiter=';')
                writer.writerow(kwargs['header'])
                writer.writerow(kwargs['data'][1])

        mock_import_threaded_local.import_data.side_effect = write_fail_file
        try:
            result = self.controller._run_legacy_import(
                self.mock_model, rows, dry_run=False, use_external_id=False,
                search_keys=None, strict=False
            )
        finally:
            mock_import_threaded_local.import_data.side_effect = None

        self.assertEqual(len(result['results']), 2)
        self.assertTrue(result['results'][0]['ok'])
        self.assertFalse(result['results'][1]['ok'])

    def test_legacy_uses_request_uid(self):
        rows = [{'name': 'Partner 1'}]

        odoo.http.request.env.__getitem__.return_value = self.mock_model
        odoo.http.request.db = 'test_db'
        odoo.http.request.registry = MagicMock()
        odoo.http.request.uid = 7

        self.controller._run_legacy_import(
            self.mock_model, rows, dry_run=False, use_external_id=False,
            search_keys=None, strict=False
        )

        kwargs = mock_import_threaded_local.import_data.call_args[1]
        self.assertEqual(kwargs['uid'], 7)

if __name__ == '__main__':
    unittest.main()
