import csv
import io
import json
import logging
import zipfile
from datetime import datetime

from odoo import http
from odoo.http import request, Response

_logger = logging.getLogger(__name__)

REQUIRED_ZIP_FILES = ['profile.csv', 'mappings.csv', 'sequence.csv']


class ProfileController(http.Controller):

    # ── Upload (HTTP multipart) ──────────────────────────────────────

    @http.route('/csv_import/profile/upload', type='http', auth='user',
                methods=['POST'], csrf=False)
    def upload_profile(self, **kwargs):
        """Upload a profile ZIP file. Returns JSON with the new profile."""
        file = request.httprequest.files.get('file')
        if not file:
            return self._json_error('No file uploaded', 400)

        try:
            zip_bytes = file.read()
            parsed = self._parse_profile_zip(zip_bytes)
            self._validate_profile(parsed)
            record = self._create_profile_record(parsed)
            return self._json_response(record._to_dict(full=True))
        except zipfile.BadZipFile:
            return self._json_error('Invalid ZIP file', 400)
        except Exception as e:
            _logger.warning(f'Profile upload failed: {e}')
            return self._json_error(str(e), 400)

    # ── List ─────────────────────────────────────────────────────────

    @http.route('/csv_import/profile/list', type='json', auth='user',
                methods=['POST'])
    def list_profiles(self):
        """Return summary list of all profiles."""
        profiles = request.env['csv.import.profile'].search([])
        return [p._to_dict(full=False) for p in profiles]

    # ── Get single ───────────────────────────────────────────────────

    @http.route('/csv_import/profile/<int:profile_id>', type='json',
                auth='user', methods=['POST'])
    def get_profile(self, profile_id):
        """Return full profile data."""
        profile = request.env['csv.import.profile'].browse(profile_id).exists()
        if not profile:
            return {'error': 'Profile not found'}
        return profile._to_dict(full=True)

    # ── Create (JSON-RPC) ─────────────────────────────────────────────

    @http.route('/csv_import/profile/create', type='json', auth='user',
                methods=['POST'])
    def create_profile(self, data):
        """Create a new profile from JSON data (used by ConfigView)."""
        if not data.get('name'):
            return {'error': 'Profile must have a name'}

        try:
            vals = {
                'name': data.get('name'),
                'version': data.get('version', '1.0'),
                'description': data.get('description', ''),
                'odoo_min_version': data.get('odoo_min_version', ''),
                'mappings': json.dumps(data.get('mappings', [])),
                'sequence': json.dumps(data.get('sequence', [])),
                'run_settings': json.dumps(data.get('run_settings', {})),
                'field_mappings': json.dumps(data.get('field_mappings', [])),
            }
            record = request.env['csv.import.profile'].create(vals)
            return record._to_dict(full=True)
        except Exception as e:
            _logger.warning(f'Profile create failed: {e}')
            return {'error': str(e)}

    # ── Update (JSON-RPC) ─────────────────────────────────────────────

    @http.route('/csv_import/profile/<int:profile_id>/update', type='json',
                auth='user', methods=['POST'])
    def update_profile(self, profile_id, data):
        """Update an existing profile from JSON data."""
        profile = request.env['csv.import.profile'].browse(profile_id).exists()
        if not profile:
            return {'error': 'Profile not found'}

        try:
            vals = {}
            if 'name' in data:
                if not data['name']:
                    return {'error': 'Profile must have a name'}
                vals['name'] = data['name']
            if 'version' in data:
                vals['version'] = data['version']
            if 'description' in data:
                vals['description'] = data['description']
            if 'odoo_min_version' in data:
                vals['odoo_min_version'] = data['odoo_min_version']
            if 'mappings' in data:
                vals['mappings'] = json.dumps(data['mappings'])
            if 'sequence' in data:
                vals['sequence'] = json.dumps(data['sequence'])
            if 'run_settings' in data:
                vals['run_settings'] = json.dumps(data['run_settings'])
            if 'field_mappings' in data:
                vals['field_mappings'] = json.dumps(data['field_mappings'])

            if vals:
                profile.write(vals)

            return profile._to_dict(full=True)
        except Exception as e:
            _logger.warning(f'Profile update failed: {e}')
            return {'error': str(e)}

    # ── Delete ───────────────────────────────────────────────────────

    @http.route('/csv_import/profile/<int:profile_id>/delete', type='json',
                auth='user', methods=['POST'])
    def delete_profile(self, profile_id):
        """Delete a profile."""
        profile = request.env['csv.import.profile'].browse(profile_id).exists()
        if not profile:
            return {'error': 'Profile not found'}
        profile.unlink()
        return {'ok': True}

    # ── Export (HTTP download) ───────────────────────────────────────

    @http.route('/csv_import/profile/<int:profile_id>/export', type='http',
                auth='user', methods=['GET'])
    def export_profile(self, profile_id):
        """Download profile as a ZIP file."""
        profile = request.env['csv.import.profile'].browse(
            int(profile_id)
        ).exists()
        if not profile:
            return request.not_found()

        zip_bytes = self._generate_profile_zip(profile)

        profile.sudo().write({'exported_at': datetime.now()})

        safe_name = ''.join(
            c if c.isalnum() or c in '-_' else '_' for c in profile.name
        )
        return Response(
            zip_bytes,
            headers={
                'Content-Type': 'application/zip',
                'Content-Disposition': f'attachment; filename="{safe_name}.zip"',
            },
        )

    # ── ZIP Parsing Helpers ──────────────────────────────────────────

    def _parse_profile_zip(self, zip_bytes):
        """Parse a profile ZIP into structured data."""
        buf = io.BytesIO(zip_bytes)
        result = {}

        with zipfile.ZipFile(buf, 'r') as zf:
            names = zf.namelist()

            for required in REQUIRED_ZIP_FILES:
                # Support files at root or inside a single folder
                match = None
                for name in names:
                    basename = name.split('/')[-1]
                    if basename == required:
                        match = name
                        break
                if not match:
                    raise ValueError(f'Missing required file: {required}')

            for name in names:
                if name.endswith('/'):
                    continue
                basename = name.split('/')[-1]
                if basename.endswith('.csv'):
                    content = zf.read(name).decode('utf-8-sig')
                    result[basename] = content

        parsed = {
            'meta': self._parse_key_value_csv(result.get('profile.csv', '')),
            'mappings': self._parse_mappings_csv(result.get('mappings.csv', '')),
            'sequence': self._parse_sequence_csv(result.get('sequence.csv', '')),
            'run_settings': self._parse_key_value_csv(
                result.get('run_settings.csv', '')
            ),
            'field_mappings': self._parse_field_mappings_csv(
                result.get('field_mappings.csv', '')
            ),
        }
        return parsed

    def _parse_key_value_csv(self, csv_text):
        """Parse a key,value CSV into a dict."""
        result = {}
        if not csv_text.strip():
            return result
        reader = csv.reader(io.StringIO(csv_text))
        header = next(reader, None)
        if not header:
            return result
        for row in reader:
            if len(row) >= 2:
                result[row[0].strip()] = row[1].strip()
        return result

    def _parse_mappings_csv(self, csv_text):
        """Parse mappings CSV (filename,model)."""
        result = []
        if not csv_text.strip():
            return result
        reader = csv.reader(io.StringIO(csv_text))
        next(reader, None)  # skip header
        for row in reader:
            if len(row) >= 2 and row[0].strip():
                result.append({
                    'filename': row[0].strip(),
                    'model': row[1].strip(),
                })
        return result

    def _parse_sequence_csv(self, csv_text):
        """Parse sequence CSV (order,filename[,requires])."""
        result = []
        if not csv_text.strip():
            return result
        reader = csv.reader(io.StringIO(csv_text))
        header = next(reader, None)
        has_requires = header and 'requires' in ','.join(header).lower()
        for row in reader:
            if len(row) >= 2 and row[0].strip():
                item = {
                    'order': int(row[0].strip()),
                    'filename': row[1].strip(),
                }
                if has_requires and len(row) >= 3 and row[2].strip():
                    item['requires'] = [
                        r.strip() for r in row[2].split(';') if r.strip()
                    ]
                result.append(item)
        return sorted(result, key=lambda x: x['order'])

    def _parse_field_mappings_csv(self, csv_text):
        """Parse field mappings CSV — supports both 3-column and 6-column formats."""
        result = []
        if not csv_text.strip():
            return result
        reader = csv.reader(io.StringIO(csv_text))
        header = next(reader, None)
        if not header:
            return result

        is_rich = any(
            h.strip().lower() in ('required', 'transform')
            for h in header
        )

        for row in reader:
            if not row or not row[0].strip():
                continue
            if is_rich and len(row) >= 5:
                item = {
                    'filename': row[0].strip(),
                    'csvHeader': row[1].strip(),
                    'odooField': row[2].strip(),
                    'required': row[3].strip().lower() == 'true',
                    'transform': row[4].strip(),
                }
                if len(row) >= 6 and row[5].strip():
                    item['notes'] = row[5].strip()
                result.append(item)
            elif len(row) >= 3:
                result.append({
                    'filename': row[0].strip(),
                    'csvColumn': row[1].strip(),
                    'odooField': row[2].strip(),
                })
        return result

    def _validate_profile(self, parsed):
        """Basic validation of parsed profile data."""
        meta = parsed.get('meta', {})
        if not meta.get('name'):
            raise ValueError('Profile must have a name (in profile.csv)')

    def _create_profile_record(self, parsed):
        """Create an Odoo record from parsed profile data."""
        meta = parsed['meta']
        vals = {
            'name': meta.get('name', 'Unnamed Profile'),
            'version': meta.get('version', '1.0'),
            'description': meta.get('description', ''),
            'odoo_min_version': meta.get('odoo_min_version', ''),
            'mappings': json.dumps(parsed.get('mappings', [])),
            'sequence': json.dumps(parsed.get('sequence', [])),
            'run_settings': json.dumps(parsed.get('run_settings', {})),
            'field_mappings': json.dumps(parsed.get('field_mappings', [])),
        }
        return request.env['csv.import.profile'].create(vals)

    # ── ZIP Generation ───────────────────────────────────────────────

    def _generate_profile_zip(self, profile):
        """Generate a ZIP file from a profile record."""
        buf = io.BytesIO()
        data = profile._to_dict(full=True)

        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('profile.csv', self._serialize_profile_csv(data))
            zf.writestr('mappings.csv', self._serialize_mappings_csv(
                data.get('mappings', [])
            ))
            zf.writestr('sequence.csv', self._serialize_sequence_csv(
                data.get('sequence', [])
            ))
            run_settings = data.get('run_settings', {})
            if run_settings:
                zf.writestr('run_settings.csv',
                            self._serialize_key_value_csv(run_settings))
            field_mappings = data.get('field_mappings', [])
            if field_mappings:
                zf.writestr('field_mappings.csv',
                            self._serialize_field_mappings_csv(field_mappings))

        return buf.getvalue()

    def _serialize_profile_csv(self, data):
        """Serialize profile metadata to CSV."""
        rows = [['key', 'value']]
        rows.append(['name', data.get('name', '')])
        rows.append(['version', data.get('version', '1.0')])
        if data.get('odoo_min_version'):
            rows.append(['odoo_min_version', data['odoo_min_version']])
        if data.get('description'):
            rows.append(['description', data['description']])
        return self._serialize_csv(rows)

    def _serialize_key_value_csv(self, data):
        """Serialize a dict to key,value CSV."""
        rows = [['key', 'value']]
        for key, value in data.items():
            rows.append([key, value])
        return self._serialize_csv(rows)

    def _serialize_mappings_csv(self, mappings):
        """Serialize mappings list to CSV."""
        rows = [['filename', 'model']]
        for m in mappings:
            rows.append([m.get('filename', ''), m.get('model', '')])
        return self._serialize_csv(rows)

    def _serialize_sequence_csv(self, sequence):
        """Serialize sequence list to CSV."""
        has_requires = any(s.get('requires') for s in sequence)
        if has_requires:
            rows = [['order', 'filename', 'requires']]
            for s in sequence:
                requires = ';'.join(s.get('requires', []))
                rows.append([s.get('order', ''), s.get('filename', ''), requires])
        else:
            rows = [['order', 'filename']]
            for s in sequence:
                rows.append([s.get('order', ''), s.get('filename', '')])
        return self._serialize_csv(rows)

    def _serialize_field_mappings_csv(self, field_mappings):
        """Serialize field mappings to CSV — detects format from data."""
        if not field_mappings:
            return ''
        sample = field_mappings[0]
        if 'csvHeader' in sample or 'required' in sample:
            # Rich format
            rows = [['filename', 'csv_header', 'odoo_field', 'required', 'transform', 'notes']]
            for m in field_mappings:
                rows.append([
                    m.get('filename', ''),
                    m.get('csvHeader', ''),
                    m.get('odooField', ''),
                    str(m.get('required', False)).lower(),
                    m.get('transform', ''),
                    m.get('notes', ''),
                ])
        else:
            # Simple format
            rows = [['filename', 'csv_column', 'odoo_field']]
            for m in field_mappings:
                rows.append([
                    m.get('filename', ''),
                    m.get('csvColumn', ''),
                    m.get('odooField', ''),
                ])
        return self._serialize_csv(rows)

    def _serialize_csv(self, rows):
        """Serialize a list of rows to CSV with proper quoting."""
        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator='\n')
        writer.writerows(rows)
        return buf.getvalue().rstrip('\n')

    # ── Helpers ──────────────────────────────────────────────────────

    def _json_response(self, data, status=200):
        """Return a JSON HTTP response."""
        return Response(
            json.dumps({'ok': True, 'result': data}),
            status=status,
            headers={'Content-Type': 'application/json'},
        )

    def _json_error(self, message, status=400):
        """Return a JSON error HTTP response."""
        return Response(
            json.dumps({'ok': False, 'error': message}),
            status=status,
            headers={'Content-Type': 'application/json'},
        )
