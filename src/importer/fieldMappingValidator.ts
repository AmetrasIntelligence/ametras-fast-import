import type { FieldMapping } from '@/types/fieldMapping'
import type { OdooField } from '@/api/odooClient'

export interface FieldMappingError {
  type: 'missing_required' | 'unknown_field' | 'duplicate_target' | 'invalid_transform'
  filename: string
  csvHeader?: string
  odooField?: string
  message: string
}

export function validateFieldMappings(
  mappings: FieldMapping[],
  csvHeaders: Map<string, string[]>,      // filename → headers
  modelFields: Map<string, OdooField[]>,  // model → fields
  fileToModel: Map<string, string>        // filename → model
): FieldMappingError[] {
  const errors: FieldMappingError[] = []

  // Group mappings by file
  const mappingsByFile = new Map<string, FieldMapping[]>()
  for (const m of mappings) {
    const existing = mappingsByFile.get(m.filename) || []
    existing.push(m)
    mappingsByFile.set(m.filename, existing)
  }

  for (const [filename, fileMappings] of mappingsByFile) {
    const headers = csvHeaders.get(filename) || []
    const model = fileToModel.get(filename)
    const fields = model ? modelFields.get(model) || [] : []
    const fieldNames = new Set(fields.map(f => f.name))

    // Track used target fields for duplicate check
    const usedTargets = new Set<string>()

    for (const mapping of fileMappings) {
      // Check required header exists
      if (mapping.required && !headers.includes(mapping.csvHeader)) {
        errors.push({
          type: 'missing_required',
          filename,
          csvHeader: mapping.csvHeader,
          message: `Required CSV header "${mapping.csvHeader}" not found in ${filename}`
        })
      }

      // Check odoo_field exists on model
      if (model && !fieldNames.has(mapping.odooField)) {
        errors.push({
          type: 'unknown_field',
          filename,
          odooField: mapping.odooField,
          message: `Field "${mapping.odooField}" does not exist on model ${model}`
        })
      }

      // Check for duplicate targets
      if (usedTargets.has(mapping.odooField)) {
        errors.push({
          type: 'duplicate_target',
          filename,
          odooField: mapping.odooField,
          message: `Field "${mapping.odooField}" is mapped multiple times in ${filename}`
        })
      }
      usedTargets.add(mapping.odooField)
    }
  }

  return errors
}

/**
 * Get mapping status for UI indicators.
 */
export function getFileMappingStatus(
  filename: string,
  mappings: FieldMapping[],
  csvHeaders: string[]
): 'valid' | 'partial' | 'none' {
  const fileMappings = mappings.filter(m => m.filename === filename)

  if (fileMappings.length === 0) return 'none'

  const requiredMappings = fileMappings.filter(m => m.required)
  const allRequiredMapped = requiredMappings.every(m =>
    csvHeaders.includes(m.csvHeader)
  )

  if (!allRequiredMapped) return 'none'

  // Check if all headers are mapped
  const mappedHeaders = new Set(fileMappings.map(m => m.csvHeader))
  const allHeadersMapped = csvHeaders.every(h => mappedHeaders.has(h))

  return allHeadersMapped ? 'valid' : 'partial'
}
