/**
 * Shared row transformation logic.
 * Used by both batchExecutor (addon mode) and ImportView (validation).
 */

/**
 * Transform a CSV row's data using field mappings to produce an Odoo-compatible record.
 * Handles id/.id fields, relational reference suffixes (/id, /.id), and __op__.
 */
export function transformRowData(
  rowData: Record<string, string>,
  fieldMappings: Record<string, string>
): Record<string, string | number> {
  const result: Record<string, string | number> = {}

  for (const [csvCol, odooField] of Object.entries(fieldMappings)) {
    const value = rowData[csvCol]
    if (value === undefined || value === '') continue

    // Handle id/.id fields specially for upsert
    if (odooField === 'id') {
      result['__external_id__'] = value
      continue
    }
    if (odooField === '.id') {
      const parsed = parseInt(value, 10)
      if (!Number.isNaN(parsed)) {
        result['id'] = parsed
      }
      continue
    }

    // Handle operation column for Strategy 3: Explicit Operation
    if (odooField === '__op__') {
      result['__op__'] = value
      continue
    }

    // Handle reference suffixes: /.id for database ID, /id for external ID
    if (odooField.endsWith('/.id')) {
      const parsed = parseInt(value, 10)
      if (!Number.isNaN(parsed)) {
        const targetField = odooField.slice(0, -4)
        result[targetField] = parsed
      }
      continue
    }
    if (odooField.endsWith('/id')) {
      const targetField = odooField.slice(0, -3)
      result[targetField] = value
      continue
    }

    result[odooField] = value
  }

  return result
}
