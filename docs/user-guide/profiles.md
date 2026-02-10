# Import Profiles

Import Profiles are named configurations that bundle everything needed to run a repeatable CSV import. They are stored on the Odoo server and can be shared across your team.

## What's in a Profile?

A profile captures:
*   **File-to-Model Mappings**: Which CSV files map to which Odoo models.
*   **Import Sequence**: The order files should be imported and their dependencies.
*   **Run Settings**: Batch size, retry limits, workers, etc.
*   **Field Mappings**: Detailed column-to-field assignments for each file.

## Lifecycle of a Profile

### 1. Creating a Profile
1.  Configure an import manually (select files, map models, define fields).
2.  Click **Save as Profile** on the Configure page.
3.  A ZIP file will be generated locally containing the configuration.

### 2. Uploading to Odoo
1.  Go to the **Profiles** view.
2.  Click **Upload Profile (ZIP)**.
3.  Select the ZIP file created in the previous step.
4.  The server validates the profile and stores it in the `csv.import.profile` model.

### 3. Loading a Profile
1.  On the **Profiles** view, select a profile from the list.
2.  Click **Load Profile**.
3.  The tool will automatically apply the model mappings, field mappings, and sequence to your currently selected files (matching them by filename).

### 4. Overriding Settings (RunConfig)
Profiles are intended to be "templates". When you load a profile, any changes you make (e.g., changing the batch size for a specific run) are tracked as **Overrides**. 
*   Overrides are session-specific.
*   You can reset overrides to return to the profile's original settings.
*   You can export a profile *with* your overrides as a new version.

## Import Sequence & Dependencies

The system allows you to define a strict processing order.

*   **Order**: A numerical value determining the sequence.
*   **Requires**: A list of files that must complete successfully before this file starts.

Example:
1. `partners.csv` (Order 1)
2. `contacts.csv` (Order 2, Requires: `partners.csv`)
3. `leads.csv` (Order 3, Requires: `contacts.csv`)

## ZIP Structure (For Advanced Users)

If you wish to create or edit profiles manually, the ZIP file contains several CSV files:

*   `profile.csv`: Metadata (Name, Version, Description).
*   `mappings.csv`: Filename to Model assignments.
*   `sequence.csv`: Processing order and dependencies.
*   `run_settings.csv`: Default execution settings.
*   `field_mappings.csv`: (Optional) Detailed column mappings.

See the [Technical Reference](../reference/strategies.md) for the exact CSV formats.
