"""
ORM backend — direct Odoo ORM access when running inside the Odoo server.
The only file in models/ whose sole purpose is bridging OdooBackend to the ORM.
"""
from .import_engine.backend import FieldInfo, OdooBackend


class OrmBackend(OdooBackend):
    """Backend using Odoo's ORM directly (addon mode)."""

    def __init__(self, env):
        self.env = env
        self._field_cache: dict[str, dict[str, FieldInfo]] = {}

    def search(self, model, domain, fields=None, limit=None):
        records = self.env[model].search(domain, limit=limit or 0)
        if fields:
            return records.read(fields)
        return records.ids

    def create(self, model, vals):
        return self.env[model].create(vals).id

    def write(self, model, ids, vals):
        return self.env[model].browse(ids).write(vals)

    def search_read(self, model, domain, fields, limit=None):
        return self.env[model].search_read(domain, fields, limit=limit or 0)

    def execute(self, model, method, *args, **kwargs):
        return getattr(self.env[model], method)(*args, **kwargs)

    def get_field_info(self, model):
        if model in self._field_cache:
            return self._field_cache[model]

        model_fields = self.env[model]._fields
        result = {}
        for name, field in model_fields.items():
            result[name] = FieldInfo(
                name=name,
                type=field.type,
                comodel_name=getattr(field, "comodel_name", "") or "",
                readonly=getattr(field, "readonly", False),
                store=getattr(field, "store", True),
            )
        self._field_cache[model] = result
        return result

    def check_access_rights(self, model, operation):
        self.env[model].check_access_rights(operation)
        return True

    def savepoint(self):
        return self.env.cr.savepoint(flush=False)

    def flush_all(self):
        self.env.flush_all()

    def browse_exists(self, model, record_id):
        return bool(self.env[model].browse(record_id).exists())
