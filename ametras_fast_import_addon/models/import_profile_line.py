from odoo import fields, models


class CsvImportProfileFile(models.Model):
    """A file → target-model mapping within a profile.

    Merges the JSON ``mappings`` (filename → model) and ``sequence``
    (order + dependencies) payloads into a single editable row, since both
    are keyed by filename.
    """

    _name = "csv.import.profile.file"
    _description = "CSV Import Profile — File / Model Mapping"
    _order = "sequence, id"

    profile_id = fields.Many2one(
        "csv.import.profile",
        string="Profile",
        required=True,
        ondelete="cascade",
        index=True,
    )
    sequence = fields.Integer(string="Order", default=10)
    filename = fields.Char(string="File Name", required=True)
    model_name = fields.Char(string="Target Model")
    requires = fields.Char(
        string="Requires",
        help="Semicolon-separated file names that must be imported before this one.",
    )


class CsvImportProfileFieldMapping(models.Model):
    """A single CSV column → Odoo field mapping within a profile."""

    _name = "csv.import.profile.field.mapping"
    _description = "CSV Import Profile — Field Mapping"
    _order = "filename, id"

    profile_id = fields.Many2one(
        "csv.import.profile",
        string="Profile",
        required=True,
        ondelete="cascade",
        index=True,
    )
    filename = fields.Char(string="File Name", required=True)
    csv_header = fields.Char(string="CSV Column")
    odoo_field = fields.Char(string="Odoo Field")
    required = fields.Boolean(string="Required")
    transform = fields.Char(string="Transform")
    notes = fields.Char(string="Notes")


class CsvImportProfileSetting(models.Model):
    """A single run-setting key/value pair within a profile."""

    _name = "csv.import.profile.setting"
    _description = "CSV Import Profile — Run Setting"
    _order = "key, id"

    profile_id = fields.Many2one(
        "csv.import.profile",
        string="Profile",
        required=True,
        ondelete="cascade",
        index=True,
    )
    key = fields.Char(string="Key", required=True)
    value = fields.Char(string="Value")
