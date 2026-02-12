import csv
import logging
from collections import Counter, defaultdict
from odoo import http, api
from odoo.http import request

_logger = logging.getLogger(__name__)

# Models allowed for /.id (database ID) references.
# These are standard Odoo reference data with stable IDs across instances.
STANDARD_DB_ID_MODELS = {
    "res.country",
    "res.currency",
    "uom.uom",
    "res.lang",
    "res.country.state",
    "res.partner.title"
}


class CSVImportController(http.Controller):

    @http.route('/csv_import/run', type='json', auth='user', methods=['POST'])
    def run_import(self, model, rows, use_external_id=False, search_keys=None,
                   dry_run=False, strict=False, use_legacy=False):
        """
        Import rows into specified model with deterministic upsert logic.

        Strategy priority (explicit and safe):
        1. External ID (if use_external_id=True and __external_id__ present)
        2. Natural Key Search (if search_keys declared)
        3. Create-only (default fallback)

        Reference Resolution:
        - External ID references (string values in relational fields) are resolved
          via ir.model.data before import
        - Database IDs (integers) are validated for standard models only

        Args:
            model: Odoo model name (e.g., 'res.partner')
            rows: List of dicts with field values
            use_external_id: If True, use __external_id__ for upsert via ir.model.data
            search_keys: List of field names for natural key search (e.g., ['default_code'])
            dry_run: If True, validate but don't commit (rollback after each row)
            strict: If True, fail on missing keys instead of falling back to create

        Returns:
            dict with 'results' list containing per-row status
        """
        Model = request.env[model]

        if use_legacy:
            return self._run_legacy_import(
                Model, rows, dry_run, use_external_id, search_keys, strict
            )

        # Security check
        Model.check_access_rights('create')
        Model.check_access_rights('write')

        # Validate search_keys exist on model
        if search_keys:
            model_fields = Model._fields
            for key in search_keys:
                if key not in model_fields:
                    return {'error': f"Search key '{key}' not found on model {model}"}

        return self._run_standard_import(
            Model, rows, use_external_id, search_keys, dry_run, strict
        )

    def _run_standard_import(self, Model, rows, use_external_id, search_keys,
                              dry_run, strict, warning=None):
        """
        Standard row-by-row import with savepoint per row.

        Args:
            warning: Optional warning message to include in response (e.g., fallback notice)
        """
        # Phase 1: Prefetch all external ID references in batch
        try:
            ref_map = self._prefetch_references(Model, rows)
        except ValueError as e:
            return {'error': str(e)}

        results = []
        warnings = []

        if warning:
            warnings.append(warning)

        for row in rows:
            try:
                with request.env.cr.savepoint() as sp:
                    # Resolve references in row before import
                    resolved_row, row_warnings = self._resolve_row(Model, row, ref_map)
                    warnings.extend(row_warnings)

                    result = self._import_row(
                        Model, resolved_row, use_external_id, search_keys, strict
                    )
                    results.append(result)

                    # Dry run: rollback this savepoint but report success
                    if dry_run:
                        sp.rollback()
                        result['dry_run'] = True

            except Exception as e:
                _logger.warning(f"Import error for {Model._name}: {e}")
                results.append({
                    'ok': False,
                    'error': str(e)
                })

        response = {'results': results}
        if warnings:
            response['warnings'] = warnings
        return response

    def _run_legacy_import(self, Model, rows, dry_run, use_external_id, search_keys, strict):
        """
        Use import_threaded utility from ametras_csv_importer as an alternative.
        Falls back to standard import if the addon is not available.
        """
        if not rows:
            return {'results': []}

        try:
            from odoo.addons.csv_import.legacy_importer import import_threaded
            # TODO(legacy-import): Once ametras_csv_importer includes these fixes, switch to:
            # from odoo.addons.ametras_csv_importer.odoo_csv_tools.odoo_csv_tools import import_threaded
            # and remove csv_import/legacy_importer.
        except ImportError:
            try:
                from odoo.addons.ametras_csv_importer.odoo_csv_tools.odoo_csv_tools import import_threaded
            except ImportError:
                _logger.warning(
                    "Legacy threaded import requested but ametras_csv_importer addon is not available. "
                    "Falling back to standard import."
                )
                return self._run_standard_import(
                    Model, rows, use_external_id, search_keys, dry_run, strict,
                    warning='Legacy import addon not available, used standard import instead.'
                )

        if dry_run:
            _logger.info("Dry run requested with legacy mode - falling back to standard import.")
            return self._run_standard_import(
                Model, rows, use_external_id, search_keys, dry_run, strict,
                warning='Dry run not supported in legacy mode, used standard import instead.'
            )

        import tempfile
        import os

        def normalize_legacy_value(value):
            if value is None:
                return ''
            return str(value)

        raw_header = list(rows[0].keys())
        header = []
        header_keys = []

        for key in raw_header:
            if key == '__op__':
                continue
            if key == '__external_id__':
                if use_external_id:
                    header.append('id')
                    header_keys.append('__external_id__')
                continue
            if key == 'id':
                header.append('.id')
                header_keys.append('id')
                continue
            header.append(key)
            header_keys.append(key)

        data = [[row.get(h) for h in header_keys] for row in rows]

        # Ensure 'id' column exists (required by import_threaded for indexing)
        if 'id' not in header:
            header.insert(0, 'id')
            for row in data:
                row.insert(0, '')

        # Create temp file for failures (import_threaded expects a file path, not StringIO)
        fail_fd, fail_file_path = tempfile.mkstemp(suffix='.csv', prefix='csv_import_fail_')
        os.close(fail_fd)

        # Check if backend importer job model exists and create a temporary job for logging
        backend_importer_id = None
        job_model = 'ametras.backend.importer.job'
        if job_model in request.env:
            try:
                # Create a temporary job record for logging purposes
                job = request.env[job_model].sudo().create({
                    'name': f'Legacy import: {Model._name}',
                    'state': 'running',
                })
                backend_importer_id = job.id
            except Exception as e:
                _logger.warning(f"Could not create backend importer job: {e}")

        try:
            # Define a wrapper for odoo execute_kw that calls load()
            def odoo_load_wrapper(dbname, uid, model, method, args, kwargs=None):
                # args[0] is header, args[1] is lines
                # import_threaded calls it with "load"
                # Use a new cursor for thread safety
                with request.env.registry.cursor() as cr:
                    env = api.Environment(cr, uid, request.env.context)
                    result = env[model].load(args[0], args[1])
                    cr.commit()
                    return result

            # Call the legacy threaded importer
            import_threaded.import_data(
                odoo_kw_method=odoo_load_wrapper,
                model=Model._name,
                header=header,
                data=data,
                fail_file=fail_file_path,
                registry=request.env.registry,
                dbname=request.db,
                uid=request.uid,
                environment=api.Environment,
                superuser=request.uid,
                max_connection=2,
                batch_size=max(10, min(100, len(rows) // 4)),
                context=dict(request.env.context),
                backend_importer_id=backend_importer_id,
            )

            # Check if there were failures by reading the fail file
            failed_rows = []
            if os.path.exists(fail_file_path) and os.path.getsize(fail_file_path) > 0:
                with open(fail_file_path, 'r', encoding='utf-8', newline='') as f:
                    reader = csv.reader(f, delimiter=';')
                    next(reader, None)  # skip header
                    failed_rows = list(reader)

            # Build results
            failed_row_counts = Counter(
                tuple(normalize_legacy_value(v) for v in row)
                for row in failed_rows
            )
            results = []
            failed_count = 0

            for row in data:
                key = tuple(normalize_legacy_value(v) for v in row)
                if failed_row_counts.get(key, 0) > 0:
                    failed_row_counts[key] -= 1
                    failed_count += 1
                    results.append({
                        'ok': False,
                        'strategy': 'legacy_threaded',
                        'error': 'Row failed during import'
                    })
                else:
                    results.append({'ok': True, 'strategy': 'legacy_threaded'})

            success_count = len(rows) - failed_count

            # Update job state if it exists
            if backend_importer_id and job_model in request.env:
                try:
                    job = request.env[job_model].sudo().browse(backend_importer_id)
                    job.write({'state': 'done' if failed_count == 0 else 'error'})
                except Exception:
                    pass

            return {
                'results': results,
                'note': f'Imported using legacy threaded mode. {success_count}/{len(rows)} rows succeeded.'
            }

        except Exception as e:
            _logger.error(f"Legacy import failed: {e}")
            return {'error': f'Legacy import failed: {str(e)}'}

        finally:
            # Cleanup temp file
            if os.path.exists(fail_file_path):
                try:
                    os.unlink(fail_file_path)
                except Exception:
                    pass

    def _import_row(self, Model, row, use_external_id, search_keys=None, strict=False):
        """
        Import single row with deterministic upsert logic.

        Decision tree (canonical):
        1. Has __external_id__ and use_external_id? → Strategy 1 (External ID)
        2. Has search_keys and all keys present? → Strategy 2 (Natural Key)
        3. Else → Create (or fail if strict mode)
        """
        row = dict(row)  # Make a copy
        external_id = row.pop('__external_id__', None)
        db_id = row.pop('id', None)
        operation = row.pop('__op__', None)  # Strategy 3: explicit operation column

        # Strategy 3: Explicit Operation Column (if provided)
        if operation:
            return self._handle_explicit_operation(
                Model, row, operation, external_id, use_external_id, search_keys
            )

        record = None
        strategy_used = None

        # Strategy 1: External ID lookup
        if use_external_id and external_id:
            record = self._find_by_external_id(Model, external_id)
            strategy_used = 'external_id'

        # Strategy 2: Natural Key Search (only if Strategy 1 didn't find a record)
        if not record and search_keys:
            # Check all keys are present in row
            missing_keys = [k for k in search_keys if k not in row or not row[k]]
            if missing_keys:
                if strict:
                    return {
                        'ok': False,
                        'error': f"Missing search keys: {', '.join(missing_keys)}"
                    }
                # Fall through to create
            else:
                record = self._find_by_search_keys(Model, row, search_keys)
                if record:
                    strategy_used = 'search_keys'

        # Fallback: Database ID lookup (legacy support)
        if not record and db_id:
            record = Model.browse(int(db_id)).exists()
            if record:
                strategy_used = 'db_id'

        if record:
            # Update existing
            record.write(row)
            return {
                'ok': True,
                'id': record.id,
                'external_id': external_id,
                'action': 'updated',
                'strategy': strategy_used
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
                'action': 'created',
                'strategy': 'create'
            }

    def _handle_explicit_operation(self, Model, row, operation, external_id,
                                    use_external_id, search_keys):
        """
        Strategy 3: Handle explicit operation column.
        Valid operations: create, update, skip
        """
        operation = operation.lower().strip()

        if operation == 'skip':
            return {
                'ok': True,
                'action': 'skipped',
                'strategy': 'explicit_op'
            }

        elif operation == 'create':
            new_record = Model.create(row)
            if use_external_id and external_id:
                self._create_external_id(Model, new_record.id, external_id)
            return {
                'ok': True,
                'id': new_record.id,
                'external_id': external_id,
                'action': 'created',
                'strategy': 'explicit_op'
            }

        elif operation == 'update':
            # Must have a way to identify the record
            record = None
            if use_external_id and external_id:
                record = self._find_by_external_id(Model, external_id)
            elif search_keys:
                record = self._find_by_search_keys(Model, row, search_keys)

            if not record:
                return {
                    'ok': False,
                    'error': 'Update requested but record not found'
                }

            record.write(row)
            return {
                'ok': True,
                'id': record.id,
                'external_id': external_id,
                'action': 'updated',
                'strategy': 'explicit_op'
            }

        else:
            return {
                'ok': False,
                'error': f"Unknown operation: {operation}. Valid: create, update, skip"
            }

    def _find_by_search_keys(self, Model, row, search_keys):
        """
        Strategy 2: Find record by natural key search.
        All keys must match exactly.
        """
        domain = [(key, '=', row[key]) for key in search_keys if key in row]
        if len(domain) != len(search_keys):
            return None  # Missing keys

        records = Model.search(domain, limit=2)
        if len(records) == 1:
            return records[0]
        elif len(records) > 1:
            _logger.warning(
                f"Natural key search found {len(records)} records for {Model._name} "
                f"with keys {search_keys}. Using first match."
            )
            return records[0]
        return None

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

    # -------------------------------------------------------------------------
    # Reference Resolution Methods
    # -------------------------------------------------------------------------

    def _prefetch_references(self, Model, rows):
        """
        Collect and resolve all external ID references in batch.

        Scans all rows for string values in relational fields (many2one, many2many)
        and resolves them via ir.model.data in bulk queries.

        Returns:
            dict: Map of (model_name, module, name) -> res_id
        """
        model_fields = Model._fields
        refs_by_model = defaultdict(set)

        for row in rows:
            for field_name, value in row.items():
                # Skip special fields and empty values
                if field_name in ('__external_id__', '__op__', 'id') or not value:
                    continue
                if field_name not in model_fields:
                    continue

                field = model_fields[field_name]

                # Only process relational fields with string values (external IDs)
                if field.type == 'many2one' and isinstance(value, str):
                    if self._is_external_id(value):
                        refs_by_model[field.comodel_name].add(value)

                elif field.type == 'many2many' and isinstance(value, str):
                    if self._is_external_id(value):
                        for ref in self._parse_refs(value):
                            refs_by_model[field.comodel_name].add(ref)

        # Resolve all references in bulk (one query per model)
        ref_map = {}
        for model_name, ext_ids in refs_by_model.items():
            # Parse and group by module for efficient querying
            parsed = [(self._normalize_ext_id(x), x) for x in ext_ids]
            names = [p[0][1] for p in parsed]
            modules = list(set(p[0][0] for p in parsed))

            imd_records = request.env["ir.model.data"].sudo().search([
                ("model", "=", model_name),
                ("module", "in", modules),
                ("name", "in", names)
            ])

            for imd in imd_records:
                ref_map[(model_name, imd.module, imd.name)] = imd.res_id

        return ref_map

    def _resolve_row(self, Model, row, ref_map):
        """
        Resolve all references in a single row using prefetched map.

        Returns:
            tuple: (resolved_row dict, list of warning messages)
        """
        model_fields = Model._fields
        resolved = {}
        warnings = []

        for field_name, value in row.items():
            # Pass through special fields unchanged
            if field_name in ('__external_id__', '__op__'):
                resolved[field_name] = value
                continue

            # Pass through empty values
            if not value:
                resolved[field_name] = value
                continue

            # Pass through fields not in model (will be handled/ignored by Odoo)
            if field_name not in model_fields:
                resolved[field_name] = value
                continue

            field = model_fields[field_name]

            # Many2One field resolution
            if field.type == 'many2one':
                if isinstance(value, str) and self._is_external_id(value):
                    # External ID reference - resolve via ref_map
                    resolved[field_name] = self._lookup_ref(
                        field.comodel_name, value, ref_map
                    )
                elif isinstance(value, int):
                    # Database ID - validate for standard models only
                    if field.comodel_name in STANDARD_DB_ID_MODELS:
                        # Validate record exists
                        record = request.env[field.comodel_name].browse(value).exists()
                        if not record:
                            raise ValueError(
                                f"Record {value} not found in {field.comodel_name}"
                            )
                        resolved[field_name] = value
                        warnings.append(
                            f"Field '{field_name}' uses database ID {value}. "
                            f"Consider migrating to external ID for portability."
                        )
                    else:
                        raise ValueError(
                            f"Raw database ID not allowed for field '{field_name}' "
                            f"(model {field.comodel_name}). Use external ID instead."
                        )
                else:
                    resolved[field_name] = value

            # Many2Many field resolution
            elif field.type == 'many2many':
                if isinstance(value, str) and self._is_external_id(value):
                    # Pipe or comma-delimited external IDs
                    refs = self._parse_refs(value)
                    ids = [
                        self._lookup_ref(field.comodel_name, ref, ref_map)
                        for ref in refs
                    ]
                    # Use command (6, 0, ids) to replace all
                    resolved[field_name] = [(6, 0, ids)]
                elif isinstance(value, list):
                    # Already a list (possibly with commands) - pass through
                    resolved[field_name] = value
                else:
                    resolved[field_name] = value

            # All other fields pass through unchanged
            else:
                resolved[field_name] = value

        return resolved, warnings

    def _is_external_id(self, value):
        """
        Check if value looks like an external ID reference.

        External IDs are strings that are NOT purely numeric.
        """
        if not isinstance(value, str):
            return False
        # If it's purely numeric, it's a database ID, not an external ID
        return not value.strip().isdigit()

    def _parse_refs(self, value):
        """
        Parse pipe or comma-delimited references.

        Supports both:
        - "ref1|ref2|ref3" (pipe-delimited, preferred)
        - "ref1,ref2,ref3" (comma-delimited, legacy)
        """
        if not value:
            return []
        delimiter = "|" if "|" in value else ","
        return [x.strip() for x in value.split(delimiter) if x.strip()]

    def _normalize_ext_id(self, value):
        """
        Normalize external ID to (module, name) tuple.

        - "module.name" -> ("module", "name")
        - "name" -> ("__import__", "name")
        """
        value = value.strip()
        if "." in value:
            module, name = value.split(".", 1)
            return (module, name)
        else:
            return ("__import__", value)

    def _lookup_ref(self, model_name, value, ref_map):
        """
        Lookup resolved ID from prefetch map.

        Raises ValueError if external ID not found.
        """
        module, name = self._normalize_ext_id(value)
        key = (model_name, module, name)
        if key not in ref_map:
            raise ValueError(
                f"External ID '{value}' not found for model {model_name}"
            )
        return ref_map[key]

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

    @http.route('/csv_import/info', type='json', auth='user', methods=['POST'])
    def get_info(self):
        """
        Return addon information including version.
        Used by the client to check compatibility.

        Returns:
            dict with version and other metadata
        """
        # Get the module's installed version from ir.module.module
        module = request.env['ir.module.module'].sudo().search([
            ('name', '=', 'csv_import'),
            ('state', '=', 'installed')
        ], limit=1)

        if module:
            # Full version is like "16.0.1.0.0", extract module version "1.0.0"
            full_version = module.installed_version or ''
            parts = full_version.split('.')
            # Skip Odoo version prefix (e.g., "16.0") and take the rest
            if len(parts) >= 3:
                module_version = '.'.join(parts[2:])  # "1.0.0"
            else:
                module_version = full_version
        else:
            module_version = 'unknown'

        return {
            'version': module_version,
            'name': 'CSV Import API',
            'odoo_version': request.env['ir.module.module'].sudo().search([
                ('name', '=', 'base')
            ], limit=1).installed_version or 'unknown'
        }
