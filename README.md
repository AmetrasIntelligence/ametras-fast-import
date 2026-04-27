# Ametras Fast Import for Odoo

Language: **[EN](README.md)** | **[DE](README-GER.md)**

Ametras Fast Import helps you import large CSV files into Odoo with a guided UI, reusable profiles, and import progress tracking.

This README is focused on **end users** (installation and daily usage), not internal architecture.

## What You Need

- Access to an Odoo 16+ server
- An Odoo user with import permissions for the target models
- CSV files to import
- Optional (for full feature set): the `ametras_fast_import_addon` installed on your Odoo server

## Installation

You can use Ametras Fast Import in two ways:

1. **Desktop App (Electron client)**
2. **Inside Odoo (Addon / embedded view)**

### Option 1: Desktop App

Install the app package provided by your team (typically `.dmg` on macOS, `.exe` on Windows, `.AppImage` on Linux).

The app is currently **not code-signed by Apple/Microsoft**. This means macOS and Windows may block it on first run.

#### macOS: "App can't be opened" / "developer cannot be verified"

Use one of these methods:

1. In Finder, locate the app, then **Control-click** it and choose **Open**.
2. Click **Open** again in the warning dialog.

If it is still blocked:

1. Open **System Settings**.
2. Go to **Privacy & Security**.
3. In the Security section, find the blocked app message.
4. Click **Open Anyway**.
5. Confirm by clicking **Open**.

#### Windows: "Windows protected your PC"

1. Start the installer/app.
2. In the SmartScreen dialog, click **More info**.
3. Click **Run anyway**.
4. Continue installation.

### Option 2: Odoo Addon (embedded mode)

If your administrator provides the addon mode, install `ametras_fast_import_addon` in your Odoo addons path and install it from Odoo Apps.

Embedded mode provides all server-side features (for example dry-run/row validation, server logs, and server profile management).

## First Login (Desktop App)

On the login screen:

1. Enter **Server Host** (example: `mycompany.odoo.com` or `192.168.1.100/odoo`).
2. Optionally open **Port & SSL** and adjust if needed.
3. Enter **Database**, **Username**, **Password**.
4. Click **Connect**.

Tips:

- You can save/reuse **Saved Connections**.
- You can remove a saved connection with the `x` button.

## Import Workflow

### 1) Open `Import`

- Go to **Import**.
- Add files with **Add Files** or drag and drop CSV files.

### 2) Choose Profile and Settings

At the top of Import:

- **Profile tab**: select an existing import profile (optional).
- **Settings tab**: configure import behavior (see settings section below).

### 3) Configure Each File

For every uploaded file:

1. Check **CSV Preview**.
2. Select **Target Model**.
3. Review and adjust **Field Mappings**.
4. (Optional) Click **Validate Random Row (Dry Run)** when available.

When mappings are ready, click **Start Import**.

### 4) Monitor in `Run`

During import you can:

- **Pause** / **Resume**
- **Skip File**
- **Abort**

You can also monitor per-file progress, success count, and failed count.

### 5) Review in `Result`

After import, the Result page shows:

- Total rows
- Successful rows
- Failed rows
- Duration

If there are errors, you can:

- **Download Unified Error Log (CSV)**
- **Download Failed Rows ZIP (.csv)**
- **Retry Failed Rows** (when available)

## Settings Explained

In `Import -> Settings`, you can control:

- **Batch Size**: rows per request batch.
- **Workers**: parallel processing workers.
- **Encoding**: CSV text encoding (`UTF-8`, `UTF-8 BOM`, `Latin-1`, `CP1252`).
- **Delimiter**: comma, semicolon, tab, or auto-detect.
- **Skip header row**: usually enabled for normal CSV files.
- **Dry run (validate only)**: validates without writing data (available in addon/embedded mode).
- **Language**: optional Odoo language code (for example `de_DE`) in addon/embedded mode.

Default settings are safe for most imports. Tune `Batch Size` and `Workers` only if you need different performance behavior.

## Profiles

Profiles help you reuse import configuration (model mapping, field mapping, sequence, settings).

### Create or Update from `Import`

- **Save as New Profile**: save current setup as a new profile.
- **Update Profile**: update the selected profile with your latest changes.

### Manage in `Profiles`

In the **Profiles** page, you can:

- **Import Profile (ZIP)** (server profiles, when available)
- **Import Local Profile (ZIP)**
- **Export Profile (ZIP)**
- **Delete** profile
- **Push to Server** for local profiles

Important:

- Profile file matching is based on filenames.
- If required files are missing, the app warns you.
- You can still import extra files not listed in the profile.

## Embedded vs Desktop Differences

- **Embedded (Addon in Odoo)**: full feature set.
- **Desktop Standalone**: works without the addon, but some features are unavailable (for example dry run/row validation, server logs, and server-side profile features).

## Quick Troubleshooting

- Connection fails:
  - Re-check host, port, SSL, DB, username/password.
  - Test login in the normal Odoo web UI first.
- Many row errors:
  - Verify delimiter/encoding.
  - Re-check field mappings and required fields.
  - Export failed rows and re-import only corrected rows.
- Profile not applying as expected:
  - Ensure CSV filenames match the profile names.
  - Review mapping and import sequence in the Profiles page.
