# Ametras Fast Import — Standalone Desktop Client

Language: **[EN](README.md)** | **[DE](README-GER.md)**

Ametras Fast Import is a **standalone desktop application** for importing large CSV files into Odoo. It runs as an Electron app on your computer and connects directly to any Odoo 16+ server over the network.

> **This is not an Odoo addon.**
> You do not install anything on your Odoo server. The app runs entirely on your desktop and communicates with Odoo via its standard JSON-RPC API.

## What You Need

- The Ametras Fast Import desktop app installed on your computer
- Access to an Odoo 16+ server (cloud or on-premise)
- An Odoo user account with import permissions for the target models
- CSV files to import

## Installation

Install the app package provided by your team:

- **macOS**: `.dmg`
- **Windows**: `.exe`
- **Linux**: `.AppImage`

The app is currently **not code-signed by Apple/Microsoft**, so macOS and Windows may block it on first run.

### macOS: "App can't be opened" / "developer cannot be verified"

Use one of these methods:

1. In Finder, locate the app, then **Control-click** it and choose **Open**.
2. Click **Open** again in the warning dialog.

If it is still blocked:

1. Open **System Settings**.
2. Go to **Privacy & Security**.
3. Find the blocked app message in the Security section.
4. Click **Open Anyway**.
5. Confirm by clicking **Open**.

### Windows: "Windows protected your PC"

1. Start the installer or app.
2. In the SmartScreen dialog, click **More info**.
3. Click **Run anyway**.
4. Continue installation.

## First Login

On the login screen:

1. Enter **Server Host** (example: `mycompany.odoo.com` or `192.168.1.100/odoo`).
2. Optionally open **Port & SSL** and adjust if needed.
3. Enter **Database**, **Username**, and **Password**.
4. Click **Connect**.

Tips:

- You can save and reuse **Saved Connections**.
- Remove a saved connection with the `x` button.

## Import Workflow

### 1) Open `Import`

- Go to **Import**.
- Add files with **Add Files** or drag and drop CSV files onto the screen.

### 2) Choose Profile and Settings

At the top of Import:

- **Profile tab**: select an existing import profile (optional).
- **Settings tab**: configure import behavior (see Settings section below).

### 3) Configure Each File

For every uploaded file:

1. Check the **CSV Preview**.
2. Select the **Target Model**.
3. Review and adjust **Field Mappings**.

When mappings are ready, click **Start Import**.

### 4) Monitor in `Run`

During import you can:

- **Pause** / **Resume**
- **Skip File**
- **Abort**

Per-file progress, success count, and failed count are shown in real time.

### 5) Review in `Result`

After import, the Result page shows:

- Total rows
- Successful rows
- Failed rows
- Duration

If there are errors, you can:

- **Download Unified Error Log (CSV)**
- **Download Failed Rows ZIP (.csv)**
- **Retry Failed Rows**

## Settings

In `Import -> Settings`:

- **Batch Size**: rows per request batch.
- **Encoding**: CSV text encoding (`UTF-8`, `UTF-8 BOM`, `Latin-1`, `CP1252`).
- **Delimiter**: comma, semicolon, tab, or auto-detect.
- **Skip header row**: enabled by default for standard CSV files.

Default settings are safe for most imports. Adjust **Batch Size** only if you need different performance behavior.

## Profiles

Profiles let you reuse import configuration (model mapping, field mapping, sequence, settings).

### Create or Update from `Import`

- **Save as New Profile**: save current setup as a new profile.
- **Update Profile**: update the selected profile with your latest changes.

### Manage in `Profiles`

In the **Profiles** page you can:

- **Import Local Profile (ZIP)**
- **Export Profile (ZIP)**
- **Delete** a profile

Important:

- Profile file matching is based on filenames.
- If required files are missing, the app warns you.
- You can still import extra files not listed in the profile.

## Troubleshooting

- **Connection fails**: re-check host, port, SSL, database, username, and password. Test login in the normal Odoo web UI first.
- **Many row errors**: verify delimiter and encoding. Re-check field mappings and required fields. Export failed rows and re-import only the corrected rows.
- **Profile not applying as expected**: ensure CSV filenames match the profile's expected filenames. Review mapping and import sequence in the Profiles page.
