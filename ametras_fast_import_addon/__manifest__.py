{
    "name": "Ametras Fast Import",
    "version": "16.0.13",
    "category": "Tools",
    "summary": "Ametras Fast Import — embedded Vue frontend for CSV importing",
    "description": """
        Provides JSON-RPC endpoints and an embedded Vue frontend for CSV importing.
        - Import endpoint: /ametras_fast_import/run
        - Profile management: upload, list, get, delete, export
        - File operations via ir.attachment
        - Savepoint per row (one failure doesn't kill the batch)
        - External ID (xml_id) upsert support
        - ACL checks before import
    """,
    "author": "Ametras",
    "depends": ["base", "web", "queue_job"],
    "data": [
        "security/ir.model.access.csv",
        "views/actions.xml",
        "views/menu.xml",
        "data/cron.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "ametras_fast_import_addon/static/vue/style.css",
            "ametras_fast_import_addon/static/src/css/csv_import_dialog.css",
            "ametras_fast_import_addon/static/src/js/csv_import_action.js",
            "ametras_fast_import_addon/static/src/js/csv_import_log_list.js",
            "ametras_fast_import_addon/static/src/xml/csv_import_action.xml",
        ],
    },
    "installable": True,
    "application": True,
    "license": "LGPL-3",
}
