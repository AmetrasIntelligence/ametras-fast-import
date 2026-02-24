# Connecting to Odoo

The CSV Import Tool communicates with Odoo via JSON-RPC.

## Server URL

Enter the full URL of your Odoo instance, including the protocol (`http://` or `https://`).
Example: `https://my-odoo-server.com`

## Database Selection

Once you enter a valid server URL, the application will attempt to fetch the list of available databases. Select the database you want to import data into.

## Authentication

Enter your Odoo username (email) and password. The application uses standard Odoo authentication.

### Session Management

The tool maintains a session with Odoo. If the session expires, you will be prompted to log in again. Sessions are stored securely within the Electron application's persistent storage.

### Multi-Server Support

The application remembers the credentials and settings for multiple servers. When you switch between servers, the tool will automatically load the corresponding saved mappings and configuration.

## Troubleshooting Connection Issues

*   **Network Error**: Check your internet connection and ensure the Odoo server is reachable.
*   **Access Denied**: Verify your username and password. Ensure the user has the necessary permissions in Odoo (at least 'create' and 'write' access for the models you intend to import).
*   **Incompatible Addon**: Ensure the `ametras_fast_import_addon` addon is installed on the Odoo server. The tool will check for the addon's presence upon connection.
