# Extending the Tool

This guide explains how to add new features or customizations to the CSV Import Tool.

## Shared Utilities

The following utilities are available for reuse across the codebase:

### Row Transformation (`src/utils/rowTransform.ts`)

`transformRowData()` applies field mappings, ID columns, and relational reference transforms to a single row. Used by both the addon-mode batch executor and standalone executor.

### File Downloads (`src/utils/download.ts`)

*   `downloadFile(content, filename, mimeType)` — trigger a browser file download with arbitrary content.
*   `downloadCSV(content, filename)` — download content as a `.csv` file.
*   `downloadJSON(data, filename)` — serialize an object to JSON and download it.

### CSV Parse Config (`src/importer/csvParser.ts`)

`buildParseConfig()` constructs a PapaParse config object from the current settings (delimiter, encoding, etc.).

## Adding a New Field Transform

Field transforms are used to modify data before it's sent to Odoo.

1.  **Define the Type**: Add the new transform type to `src/types/fieldMapping.ts`.
    ```typescript
    export type FieldTransform =
      | { type: 'passthrough' }
      // ...
      | { type: 'my_new_transform'; parameter: string }
    ```
2.  **Add Frontend Logic**: Update the transform handling in `src/utils/rowTransform.ts` (the shared `transformRowData` function).
3.  **Update the UI**: Modify the field mapping UI in `src/views/ImportView.vue` to allow users to select the new transform and provide any necessary parameters.

## Adding Smart Model Suggestions

The tool suggests Odoo models based on filenames in `src/utils/smartMapping.ts`.

1.  **Update the Alias Map**: Add common filename patterns to the `MODEL_ALIASES` constant.
    ```typescript
    const MODEL_ALIASES: Record<string, string> = {
      'customers': 'res.partner',
      'vendors': 'res.partner',
      'my_custom_files': 'my.custom.model'
    };
    ```
2.  **Adjust Scoring**: If you need more complex logic, modify the `scoreModelMatch` function.

## Adding Smart Field Suggestions

Field suggestions are managed in `src/utils/smartFieldMapping.ts`.

1.  **Add Language Aliases**: The tool supports aliases for different languages. Add new terms to the `FIELD_ALIASES` map.
    ```typescript
    const FIELD_ALIASES: Record<string, string[]> = {
      'phone': ['tel', 'telefon', 'handy', 'mobile'],
      'my_field': ['alias1', 'alias2']
    };
    ```

## Removed Files

The following files were removed during refactoring and their functionality has been consolidated:

*   `src/components/FieldMappingTable.vue` — field mapping table is now inline in `ImportView.vue`.
*   `src/components/FileMappingRow.vue` — file mapping rows are now inline in `ImportView.vue`.
*   `src/composables/useImportValidation.ts` — validation logic is now in `src/importer/fieldMappingValidator.ts`.

## Extending the Odoo Backend

The backend logic is primarily in `csv_import/controllers/import_controller.py`.

*   **Custom Upsert Logic**: If you need to change how records are identified, modify the `_import_row` method.
*   **Post-processing**: To perform actions after a row is imported (e.g., triggering a workflow), add logic to `run_import` after the `_import_row` call.
