{
    'name': 'CSV Import API',
    'version': '16.0.1.0.0',
    'category': 'Tools',
    'summary': 'JSON-RPC endpoint for external CSV import tool with profile management',
    'description': '''
        Provides JSON-RPC endpoints for the CSV Import Tool.
        - Import endpoint: /ametras_fast_import/run
        - Profile management: upload, list, get, delete, export
        - Savepoint per row (one failure doesn't kill the batch)
        - External ID (xml_id) upsert support
        - ACL checks before import
    ''',
    'author': 'Ametras',
    'depends': ['base'],
    'data': [
        'security/ir.model.access.csv',
    ],
    'installable': True,
    'application': False,
    'license': 'LGPL-3',
}
