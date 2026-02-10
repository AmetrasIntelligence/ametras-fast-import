# Managing Files

The **Files** view is where you manage the CSV files you want to import.

## Adding Files

There are two ways to add files:
1.  **Drag & Drop**: Drag CSV files from your file manager directly into the application window.
2.  **File Browser**: Click the drop zone to open your system's file selection dialog.

The tool supports `.csv` files. If you select a large file, the application will handle it efficiently using streaming techniques.

## File List

Each added file is displayed as a row in the file list. The row shows:
*   **Filename**: The name of the file.
*   **Size**: The file size on disk.
*   **Status**: A visual indicator of the mapping status (Gray = Pending, Red = Error, Green = Ready).
*   **Actions**: Buttons to remove the file or move it up/down in the list (though the import order is primarily determined by the sequence configuration).

## File Analysis

When a file is added, the tool performs an automatic analysis:
1.  **Delimiter Detection**: Automatically identifies if the file uses commas, semicolons, or tabs as separators.
2.  **Encoding Detection**: Attempts to identify the file encoding (UTF-8, Latin-1, etc.).
3.  **Header Extraction**: Reads the first row to identify the column headers.
4.  **Data Sampling**: Reads the first 4 rows to provide a data preview and help with field type detection.

## Data Preview

Click the chevron icon at the end of a file row to expand the preview. This shows:
*   A table containing the first few rows of the CSV file.
*   The detected headers.
*   A summary of the file's metadata (delimiter, encoding, estimated row count).

## Removing Files

To remove a file from the list, click the trash can icon. This only removes the file from the tool's current session; it does not delete the file from your computer.
