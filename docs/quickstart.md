# Quickstart

## 1. Connect to Odoo

Enter your Odoo server URL (e.g., `https://my-odoo-server.com`), select a database, and log in. The tool auto-detects whether the `ametras_fast_import` addon is installed and switches to standalone mode if not.

Sessions are stored securely and the tool remembers credentials for multiple servers.

## 2. Add CSV Files

Drag & drop CSV files into the application or use the file browser. The tool automatically:
- Detects delimiter and encoding
- Extracts headers
- Samples the first rows for preview and type detection

Click the chevron next to a filename to preview data.

## 3. Configure Mappings

1. For each file, select a target **Odoo Model** (smart suggestions provided based on filename).
2. **Map Fields** — the tool auto-suggests mappings based on header names. Review relational fields and transforms.
3. Adjust **Run Settings** if needed (batch size, workers, etc.). See [Settings](settings.md).
4. Optionally save the configuration as a **Profile** for reuse. See [Profiles](profiles.md).

## 4. Run Import

1. Verify all files show a green status indicator.
2. Click **Start Import**.
3. Monitor progress: per-file bars, success/failure counters, and ETA.
4. Use **Pause** / **Resume** / **Abort** as needed.

## 5. Review Results

After completion, the Results view shows successes and failures per file. Click **Export Errors** to download a CSV of failed rows with error messages — fix the data, remove the `__error__` column, and re-import.
