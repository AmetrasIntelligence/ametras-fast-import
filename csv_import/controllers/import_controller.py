import logging
from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class CSVImportController(http.Controller):

    @http.route('/csv_import/run', type='json', auth='user', methods=['POST'])
    def run_import(self, model, rows, use_external_id=False):
        """
        Import rows into specified model.

        Args:
            model: Odoo model name (e.g., 'res.partner')
            rows: List of dicts with field values
            use_external_id: If True, use 'id' column for upsert via ir.model.data

        Returns:
            dict with 'results' list containing per-row status
        """
        Model = request.env[model]

        # Security check
        Model.check_access_rights('create')
        Model.check_access_rights('write')

        results = []

        for row in rows:
            try:
                with request.env.cr.savepoint():
                    result = self._import_row(Model, row, use_external_id)
                    results.append(result)
            except Exception as e:
                _logger.warning(f"Import error for {model}: {e}")
                results.append({
                    'ok': False,
                    'error': str(e)
                })

        return {'results': results}

    def _import_row(self, Model, row, use_external_id):
        """Import single row with upsert logic."""
        row = dict(row)  # Make a copy
        external_id = row.pop('__external_id__', None)
        db_id = row.pop('id', None)

        record = None

        # Try to find existing record
        if use_external_id and external_id:
            record = self._find_by_external_id(Model, external_id)
        elif db_id:
            record = Model.browse(int(db_id)).exists()

        if record:
            # Update existing
            record.write(row)
            return {
                'ok': True,
                'id': record.id,
                'external_id': external_id,
                'action': 'updated'
            }
        else:
            # Create new
            new_record = Model.create(row)

            # Create external ID if provided
            if use_external_id and external_id:
                self._create_external_id(Model, new_record.id, external_id)

            return {
                'ok': True,
                'id': new_record.id,
                'external_id': external_id,
                'action': 'created'
            }

    def _find_by_external_id(self, Model, external_id):
        """Find record by external ID (module.name format)."""
        if '.' not in external_id:
            external_id = f'__import__.{external_id}'

        module, name = external_id.split('.', 1)

        imd = request.env['ir.model.data'].sudo().search([
            ('module', '=', module),
            ('name', '=', name),
            ('model', '=', Model._name)
        ], limit=1)

        if imd:
            return Model.browse(imd.res_id).exists()
        return None

    def _create_external_id(self, Model, record_id, external_id):
        """Create ir.model.data entry for external ID."""
        if '.' in external_id:
            module, name = external_id.split('.', 1)
        else:
            module, name = '__import__', external_id

        request.env['ir.model.data'].sudo().create({
            'module': module,
            'name': name,
            'model': Model._name,
            'res_id': record_id
        })

    @http.route('/csv_import/models', type='json', auth='user', methods=['POST'])
    def list_models(self):
        """List importable models for current user."""
        models = request.env['ir.model'].search([
            ('transient', '=', False)
        ])

        result = []
        for model in models:
            try:
                request.env[model.model].check_access_rights('create')
                result.append({
                    'id': model.id,
                    'model': model.model,
                    'name': model.name
                })
            except Exception:
                pass  # User has no access

        return result
