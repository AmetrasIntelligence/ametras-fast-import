import json
import logging
from odoo import api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


class CsvImportProfile(models.Model):
    _name = 'csv.import.profile'
    _description = 'CSV Import Profile'
    _order = 'write_date desc'

    name = fields.Char(required=True, string='Profile Name')
    version = fields.Char(default='1.0', string='Version')
    description = fields.Text(string='Description')
    odoo_min_version = fields.Char(string='Minimum Odoo Version')

    # JSON-serialized data fields
    mappings = fields.Text(string='Mappings (JSON)', default='[]')
    sequence = fields.Text(string='Sequence (JSON)', default='[]')
    run_settings = fields.Text(string='Run Settings (JSON)', default='{}')
    field_mappings = fields.Text(string='Field Mappings (JSON)', default='[]')

    # Provenance
    derived_from = fields.Char(string='Derived From Profile')
    exported_at = fields.Datetime(string='Last Exported At')

    @api.constrains('odoo_min_version')
    def _check_odoo_min_version(self):
        """Validate that the server meets the profile's minimum Odoo version."""
        for record in self:
            if not record.odoo_min_version:
                continue
            server_version = self.env['ir.module.module'].sudo().search(
                [('name', '=', 'base')], limit=1
            ).latest_version or ''
            # Extract major version number
            try:
                min_major = int(record.odoo_min_version.split('.')[0])
                server_major = int(server_version.split('.')[0]) if server_version else 0
                if server_major and server_major < min_major:
                    raise ValidationError(
                        f'Profile requires Odoo {record.odoo_min_version}+, '
                        f'but server is {server_version}'
                    )
            except (ValueError, IndexError):
                pass  # Non-numeric version, skip check

    def _to_dict(self, full=False):
        """Serialize record to dict for JSON-RPC responses."""
        self.ensure_one()
        data = {
            'id': self.id,
            'name': self.name,
            'version': self.version,
            'description': self.description or '',
            'odoo_min_version': self.odoo_min_version or '',
            'derived_from': self.derived_from or '',
            'created_at': self.create_date.isoformat() if self.create_date else '',
            'updated_at': self.write_date.isoformat() if self.write_date else '',
        }
        if full:
            data.update({
                'mappings': json.loads(self.mappings or '[]'),
                'sequence': json.loads(self.sequence or '[]'),
                'run_settings': json.loads(self.run_settings or '{}'),
                'field_mappings': json.loads(self.field_mappings or '[]'),
            })
        return data
