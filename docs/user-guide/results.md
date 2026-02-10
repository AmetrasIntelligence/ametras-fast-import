# Reviewing Results

After an import completes (or is aborted), the **Results** view provides a summary of the outcome.

## The Results Summary

You will see a breakdown for each file:
*   **Successes**: Number of rows successfully created or updated in Odoo.
*   **Failures**: Number of rows that failed after all retry attempts.
*   **Retries**: Total number of retry attempts made during the process.

## Investigating Errors

The Results view allows you to see why specific rows failed.
*   **Error Messages**: The tool displays the exact error returned by Odoo (e.g., `Missing required field: name`, `Unique constraint violation: default_code must be unique`).
*   **Row Data**: You can see the original CSV data for the failed row to help identify the issue.

## Exporting Errors for Correction

The most powerful feature of the Results view is the **Export Errors** button.

1.  Click **Export Errors**.
2.  The tool generates a new CSV file containing **only** the rows that failed.
3.  **Error Column**: An additional column `__error__` is added to the end of each row, containing the error message from Odoo.
4.  **Fix and Re-import**:
    *   Open this file in your spreadsheet editor (Excel, LibreOffice).
    *   Read the error messages and fix the data in the corresponding columns.
    *   Remove the `__error__` column.
    *   Save the file.
    *   Go back to the **Files** view in the tool, add this fixed file, and run the import again.

## Success Data Export

While the primary focus is on errors, you can also export a list of successfully processed rows along with their resulting Odoo Database IDs and External IDs. This is useful for building mapping tables for subsequent imports in other systems.
