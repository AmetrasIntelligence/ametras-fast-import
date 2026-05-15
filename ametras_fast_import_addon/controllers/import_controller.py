import base64
import json
import logging
from odoo import http, fields
from odoo.http import request
from ..models.orm_backend import OrmBackend
from ..models.import_engine.importer import Importer, ImportConfig
from ..models.import_engine.parser import ParsedRow, ParseOptions, parse_csv_string, analyze_csv, analyze_csv_file

_logger = logging.getLogger(__name__)


class CSVImportController(http.Controller):

    @http.route('/ametras_fast_import/run', type='json', auth='user', methods=['POST'])
    def run_import(self, model, rows=None, raw_rows=None, field_mappings=None,
                   use_external_id=False, search_keys=None,
                   dry_run=False, strict=False, lang=None):
        """
        Import rows into specified model with deterministic upsert logic.

        Supports two API modes:
        1. New API: raw_rows + field_mappings (Python does all transformation)
        2. Legacy API: rows (pre-transformed by Vue's transformRowData)

        Strategy priority (explicit and safe):
        1. Explicit operation (__op__ column: create/update/skip)
        2. External ID (if use_external_id=True and __external_id__ present)
        3. Natural Key Search (if search_keys declared)
        4. Create-only (default fallback)

        Args:
            model: Odoo model name (e.g., 'res.partner')
            raw_rows: List of dicts with CSV column names as keys (new API)
            field_mappings: Dict mapping CSV columns to Odoo fields (new API)
            rows: List of dicts with Odoo field values (legacy API)
            use_external_id: If True, use __external_id__ for upsert
            search_keys: List of field names for natural key search
            dry_run: If True, validate but don't commit
            strict: If True, fail on missing keys instead of falling back

        Returns:
            dict with 'results' list containing per-row status
        """
        env = request.env
        if lang:
            env = env.with_context(lang=lang)
        backend = OrmBackend(env)

        # Security check
        backend.check_access_rights(model, 'create')
        backend.check_access_rights(model, 'write')

        # Validate search_keys exist on model
        if search_keys:
            field_info = backend.get_field_info(model)
            for key in search_keys:
                if key not in field_info:
                    return {'error': f"Search key '{key}' not found on model {model}"}

        config = ImportConfig(
            model=model,
            field_mappings=field_mappings or {},
            use_external_id=use_external_id,
            search_keys=search_keys,
            dry_run=dry_run,
            strict=strict,
        )

        importer = Importer(backend, config)

        if raw_rows is not None and field_mappings:
            # New API: raw CSV data + field mappings
            parsed = [
                ParsedRow(index=i + 1, data=row)
                for i, row in enumerate(raw_rows)
            ]
            results = importer.import_rows(parsed)
        elif rows is not None:
            # Legacy API: pre-transformed rows
            results = importer.import_pre_transformed_rows(rows)
        else:
            return {'error': 'Either raw_rows+field_mappings or rows must be provided'}

        return {
            'results': [
                {
                    'ok': r.ok,
                    'error': r.error,
                    'id': r.record_id,
                    'external_id': r.external_id,
                    'action': r.action,
                    'strategy': r.strategy,
                    **(({'dry_run': True} if r.dry_run else {})),
                }
                for r in results
            ]
        }

    @http.route('/ametras_fast_import/models', type='json', auth='user', methods=['POST'])
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

    @http.route('/ametras_fast_import/info', type='json', auth='user', methods=['POST'])
    def get_info(self):
        """
        Return addon information including version.
        Used by the client to check compatibility.
        """
        module = request.env['ir.module.module'].sudo().search([
            ('name', '=', 'ametras_fast_import_addon'),
            ('state', '=', 'installed')
        ], limit=1)

        if module:
            full_version = module.installed_version or ''
            parts = full_version.split('.')
            if len(parts) >= 3:
                module_version = '.'.join(parts[2:])
            else:
                module_version = full_version
        else:
            module_version = 'unknown'

        return {
            'version': module_version,
            'name': 'Ametras Fast Import API',
            'odoo_version': request.env['ir.module.module'].sudo().search([
                ('name', '=', 'base')
            ], limit=1).installed_version or 'unknown'
        }

    # -----------------------------------------------------------------
    # Server-side import job endpoints
    # -----------------------------------------------------------------

    @http.route('/ametras_fast_import/file/analyze', type='json', auth='user', methods=['POST'])
    def analyze_file(self, file_id, encoding='utf-8', delimiter=''):
        """
        Analyze a CSV file: detect headers, delimiter, sample rows, row count.

        Uses a 64 KB sample for header/delimiter/preview detection, and a
        streaming line count for the total row count.  For filestore-backed
        attachments this avoids loading the entire file into memory.
        """
        attachment = request.env['ir.attachment'].browse(int(file_id))
        if not attachment.exists():
            return {'error': f'Attachment {file_id} not found'}

        if attachment.store_fname:
            return analyze_csv_file(
                attachment._full_path(attachment.store_fname),
                encoding=encoding,
                delimiter=delimiter,
            )

        # Small file stored in DB — fall back to in-memory decode
        content = base64.b64decode(attachment.datas).decode(encoding, errors='replace')
        return analyze_csv(content, encoding, delimiter)

    @http.route('/ametras_fast_import/import/active', type='json', auth='user', methods=['POST'])
    def get_active_imports(self):
        """
        Return any import logs owned by the current user that are still running or paused.

        Used by RunView.onMounted to re-attach after a page refresh instead of
        starting a duplicate job over a still-running one.
        """
        logs = request.env['csv.import.log'].search([
            ('user_id', '=', request.env.user.id),
            ('job_state', 'in', ('running', 'paused', 'pending')),
        ], order='started_at desc', limit=5)

        return {
            'logs': [
                {
                    'logId': log.id,
                    'state': log.job_state,
                    'profileName': log.profile_name or '',
                    'startedAt': log.started_at.isoformat() if log.started_at else None,
                    'currentFile': log.current_file or '',
                    'progress': json.loads(log.file_progress or '{}'),
                    'successRows': log.success_rows,
                    'failedRows': log.failed_rows,
                    'totalRows': log.total_rows,
                    'isDryRun': log.is_dry_run,
                }
                for log in logs
            ]
        }

    @http.route('/ametras_fast_import/import/start', type='json', auth='user', methods=['POST'])
    def start_import(self, file_ids, config):
        """
        Start a background import job via queue_job.

        Args:
            file_ids: List of ir.attachment IDs for CSV files
            config: Dict with fileMappings, importSequence, settings

        Returns:
            dict with logId and state
        """
        total_rows = config.get('total_rows', 0)
        filenames = config.get('importSequence', [])

        log = request.env['csv.import.log'].create({
            'profile_name': config.get('profile_name', ''),
            'profile_id': config.get('profile_id', False),
            'is_dry_run': config.get('settings', {}).get('dryRun', False),
            'started_at': fields.Datetime.now(),
            'filenames': json.dumps(filenames),
            'total_rows': total_rows,
            'attachment_ids': [(6, 0, file_ids)],
            'job_config': json.dumps(config),
        })
        log.action_start_import()
        return {'logId': log.id, 'state': 'running'}

    @http.route('/ametras_fast_import/import/progress', type='json', auth='user', methods=['POST'])
    def get_import_progress(self, log_id):
        """
        Poll import progress. Called by Vue every 500ms during import.
        """
        log = request.env['csv.import.log'].browse(int(log_id))
        if not log.exists():
            return {'error': 'Log not found'}

        error_log = json.loads(log.error_log or '[]')

        return {
            'state': log.job_state or log.state,
            'progress': json.loads(log.file_progress or '{}'),
            'success_rows': log.success_rows,
            'failed_rows': log.failed_rows,
            'total_rows': log.total_rows,
            'current_file': log.current_file or '',
            'errors': error_log[:100],
            'is_dry_run': log.is_dry_run,
            'heartbeat': log.heartbeat.isoformat() if log.heartbeat else None,
        }

    @http.route('/ametras_fast_import/import/control', type='json', auth='user', methods=['POST'])
    def control_import(self, log_id, action):
        """
        Control a running import: pause, resume, cancel, skip.

        Args:
            log_id: ID of the csv.import.log record
            action: 'pause' | 'resume' | 'cancel' | 'skip'
        """
        log = request.env['csv.import.log'].browse(int(log_id))
        if not log.exists():
            return {'error': 'Log not found'}

        if action == 'cancel':
            log.write({'job_cancel_requested': True})
        elif action == 'pause':
            log.write({'job_pause_requested': True})
        elif action == 'resume':
            log.write({'job_pause_requested': False})
        elif action == 'skip':
            log.write({'job_skip_file': log.current_file or ''})
        else:
            return {'error': f'Unknown action: {action}'}

        return {'ok': True}

    @http.route('/ametras_fast_import/import/retry', type='json', auth='user', methods=['POST'])
    def retry_import(self, log_id):
        """
        Retry failed rows from a completed import.
        Creates a new log record targeting only the failed rows.
        """
        old_log = request.env['csv.import.log'].browse(int(log_id))
        if not old_log.exists():
            return {'error': 'Log not found'}

        new_log = old_log._create_resume_log()
        new_log.action_start_import()
        return {'logId': new_log.id, 'state': 'running'}
