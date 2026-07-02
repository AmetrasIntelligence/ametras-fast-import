import json
import logging

from odoo import api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


class CsvImportProfile(models.Model):
    _name = "csv.import.profile"
    _description = "CSV Import Profile"
    _order = "write_date desc"

    name = fields.Char(required=True, string="Profile Name")
    version = fields.Char(default="1.0", string="Version")
    description = fields.Text(string="Description")
    odoo_min_version = fields.Char(string="Minimum Odoo Version")

    # Editable, normalized child records (source of truth for the JSON below).
    file_ids = fields.One2many(
        "csv.import.profile.file", "profile_id", string="Files & Models"
    )
    field_mapping_ids = fields.One2many(
        "csv.import.profile.field.mapping", "profile_id", string="Field Mappings"
    )
    setting_ids = fields.One2many(
        "csv.import.profile.setting", "profile_id", string="Run Settings"
    )

    # JSON-serialized interchange fields, computed from the child records above.
    # These remain the wire format consumed by the import engine, the REST
    # controller, the Vue client and the ZIP export/import.
    mappings = fields.Text(
        string="Mappings (JSON)",
        compute="_compute_mappings",
        store=True,
    )
    sequence = fields.Text(
        string="Sequence (JSON)",
        compute="_compute_sequence",
        store=True,
    )
    run_settings = fields.Text(
        string="Run Settings (JSON)",
        compute="_compute_run_settings",
        store=True,
    )
    field_mappings = fields.Text(
        string="Field Mappings (JSON)",
        compute="_compute_field_mappings",
        store=True,
    )

    # Provenance
    derived_from = fields.Char(string="Derived From Profile")
    exported_at = fields.Datetime(string="Last Exported At")

    # ── Computed JSON interchange (children → JSON) ───────────────────

    @api.depends("file_ids", "file_ids.filename", "file_ids.model_name")
    def _compute_mappings(self):
        for record in self:
            record.mappings = json.dumps(
                [
                    {"filename": f.filename, "model": f.model_name or ""}
                    for f in record.file_ids
                ]
            )

    @api.depends(
        "file_ids", "file_ids.filename", "file_ids.sequence", "file_ids.requires"
    )
    def _compute_sequence(self):
        for record in self:
            items = []
            for order, f in enumerate(record.file_ids, start=1):
                item = {"order": order, "filename": f.filename}
                requires = [r.strip() for r in (f.requires or "").split(";") if r.strip()]
                if requires:
                    item["requires"] = requires
                items.append(item)
            record.sequence = json.dumps(items)

    @api.depends(
        "field_mapping_ids",
        "field_mapping_ids.filename",
        "field_mapping_ids.csv_header",
        "field_mapping_ids.odoo_field",
        "field_mapping_ids.required",
        "field_mapping_ids.transform",
        "field_mapping_ids.notes",
    )
    def _compute_field_mappings(self):
        for record in self:
            record.field_mappings = json.dumps(
                [
                    {
                        "filename": m.filename,
                        "csvHeader": m.csv_header or "",
                        "odooField": m.odoo_field or "",
                        "required": m.required,
                        "transform": m.transform or "",
                        "notes": m.notes or "",
                    }
                    for m in record.field_mapping_ids
                ]
            )

    @api.depends("setting_ids", "setting_ids.key", "setting_ids.value")
    def _compute_run_settings(self):
        for record in self:
            record.run_settings = json.dumps(
                {s.key: s.value or "" for s in record.setting_ids if s.key}
            )

    @api.constrains("odoo_min_version")
    def _check_odoo_min_version(self):
        """Validate that the server meets the profile's minimum Odoo version."""
        for record in self:
            if not record.odoo_min_version:
                continue
            server_version = (
                self.env["ir.module.module"]
                .sudo()
                .search([("name", "=", "base")], limit=1)
                .latest_version
                or ""
            )
            # Extract major version number
            try:
                min_major = int(record.odoo_min_version.split(".")[0])
                server_major = (
                    int(server_version.split(".")[0]) if server_version else 0
                )
                if server_major and server_major < min_major:
                    raise ValidationError(
                        f"Profile requires Odoo {record.odoo_min_version}+, "
                        f"but server is {server_version}"
                    )
            except (ValueError, IndexError):
                pass  # Non-numeric version, skip check

    def action_open_editor(self):
        """Open the profile viewer (Vue) in a dialog."""
        self.ensure_one()
        return {
            "type": "ir.actions.client",
            "tag": "ametras_csv_import_vue_app",
            "name": self.name,
            "target": "new",
            "params": {
                "default_view": "profile_detail",
                "profile_id": self.id,
            },
            "context": {"dialog_size": "extra-large"},
        }

    # ── JSON interchange → children (used by the REST controller) ─────

    def _apply_profile_json(self, data):
        """Rebuild child records from a JSON-shaped profile dict.

        ``data`` mirrors the wire format (already parsed): keys ``mappings``,
        ``sequence``, ``run_settings`` and ``field_mappings``. Only the keys
        present in ``data`` are touched; the JSON interchange fields recompute
        automatically from the rewritten children.
        """
        self.ensure_one()
        vals = {}
        if "mappings" in data or "sequence" in data:
            mappings = data.get("mappings")
            sequence = data.get("sequence")
            if mappings is None:
                mappings = json.loads(self.mappings or "[]")
            if sequence is None:
                sequence = json.loads(self.sequence or "[]")
            vals["file_ids"] = self._build_file_commands(mappings, sequence)
        if "field_mappings" in data:
            vals["field_mapping_ids"] = self._build_field_mapping_commands(
                data.get("field_mappings") or []
            )
        if "run_settings" in data:
            vals["setting_ids"] = self._build_setting_commands(
                data.get("run_settings") or {}
            )
        if vals:
            self.write(vals)

    def _build_file_commands(self, mappings, sequence):
        """Merge mappings (filename→model) and sequence (order/requires) rows."""
        order_by_file = {}
        requires_by_file = {}
        for idx, item in enumerate(sequence or []):
            filename = (item.get("filename") or "").strip()
            if not filename:
                continue
            order_by_file[filename] = item.get("order", idx + 1)
            requires = item.get("requires") or []
            if isinstance(requires, list):
                requires_by_file[filename] = ";".join(str(r) for r in requires)
            else:
                requires_by_file[filename] = str(requires or "")

        model_by_file = {}
        ordered = []
        for item in mappings or []:
            filename = (item.get("filename") or "").strip()
            if not filename:
                continue
            model_by_file[filename] = item.get("model") or ""
            if filename not in ordered:
                ordered.append(filename)
        for filename in order_by_file:
            if filename not in ordered:
                ordered.append(filename)
        ordered.sort(key=lambda fn: order_by_file.get(fn, 9999))

        commands = [(5, 0, 0)]
        for position, filename in enumerate(ordered, start=1):
            commands.append(
                (
                    0,
                    0,
                    {
                        "filename": filename,
                        "model_name": model_by_file.get(filename, ""),
                        "sequence": order_by_file.get(filename, position) * 10,
                        "requires": requires_by_file.get(filename, ""),
                    },
                )
            )
        return commands

    def _build_field_mapping_commands(self, field_mappings):
        commands = [(5, 0, 0)]
        for item in field_mappings or []:
            header = item.get("csvHeader")
            if header is None:
                header = item.get("csvColumn") or ""
            commands.append(
                (
                    0,
                    0,
                    {
                        "filename": item.get("filename") or "",
                        "csv_header": header or "",
                        "odoo_field": item.get("odooField") or "",
                        "required": bool(item.get("required", False)),
                        "transform": item.get("transform") or "",
                        "notes": item.get("notes") or "",
                    },
                )
            )
        return commands

    def _build_setting_commands(self, run_settings):
        commands = [(5, 0, 0)]
        for key, value in (run_settings or {}).items():
            commands.append(
                (0, 0, {"key": key, "value": "" if value is None else str(value)})
            )
        return commands

    def _to_dict(self, full=False):
        """Serialize record to dict for JSON-RPC responses."""
        self.ensure_one()
        data = {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "description": self.description or "",
            "odoo_min_version": self.odoo_min_version or "",
            "derived_from": self.derived_from or "",
            "created_at": self.create_date.isoformat() if self.create_date else "",
            "updated_at": self.write_date.isoformat() if self.write_date else "",
        }
        if full:
            data.update(
                {
                    "mappings": json.loads(self.mappings or "[]"),
                    "sequence": json.loads(self.sequence or "[]"),
                    "run_settings": json.loads(self.run_settings or "{}"),
                    "field_mappings": json.loads(self.field_mappings or "[]"),
                }
            )
        return data
