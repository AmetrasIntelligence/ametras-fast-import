import type { ImportProfile, ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import type { FieldMapping } from '@/types/fieldMapping'

export interface ValidationError {
  type: 'missing_file' | 'missing_model' | 'dependency_violation' | 'circular_dependency' | 'sequence_gap'
    | 'missing_name' | 'duplicate_filename' | 'unmapped_sequence' | 'orphan_mapping' | 'orphan_field_mapping'
    | 'non_contiguous_order'
  message: string
  filename?: string
  details?: string
}

export interface ProfileDraft {
  meta: {
    name?: string
    version?: string
    odooMinVersion?: string
    description?: string
  }
  mappings: ProfileMapping[]
  sequence: ProfileSequenceItem[]
  fieldMappings: FieldMapping[]
}

export interface ProfileValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationError[]
}

/**
 * Validate a profile draft before upload.
 */
export function validateProfileDraft(draft: ProfileDraft): ProfileValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []

  // Missing required metadata
  if (!draft.meta.name || !draft.meta.name.trim()) {
    errors.push({
      type: 'missing_name',
      message: 'Profile name is required'
    })
  }

  // Duplicate filenames in mappings
  const mappingFilenames = new Set<string>()
  for (const mapping of draft.mappings) {
    if (mappingFilenames.has(mapping.filename)) {
      errors.push({
        type: 'duplicate_filename',
        message: `Duplicate filename in mappings: "${mapping.filename}"`,
        filename: mapping.filename
      })
    }
    mappingFilenames.add(mapping.filename)
  }

  // Unmapped sequence files (in sequence but no model mapping)
  for (const item of draft.sequence) {
    const hasMapping = draft.mappings.some(m => m.filename === item.filename)
    if (!hasMapping) {
      warnings.push({
        type: 'unmapped_sequence',
        message: `File "${item.filename}" is in sequence but has no model mapping`,
        filename: item.filename
      })
    }
  }

  // Orphan mappings (mapped but not in sequence)
  const sequenceFilenames = new Set(draft.sequence.map(s => s.filename))
  for (const mapping of draft.mappings) {
    if (!sequenceFilenames.has(mapping.filename)) {
      warnings.push({
        type: 'orphan_mapping',
        message: `File "${mapping.filename}" is mapped but not in sequence`,
        filename: mapping.filename
      })
    }
  }

  // Orphan field mappings (field mappings for files not in mappings)
  for (const fm of draft.fieldMappings) {
    if (!mappingFilenames.has(fm.filename)) {
      warnings.push({
        type: 'orphan_field_mapping',
        message: `Field mapping for "${fm.filename}" references a file not in mappings`,
        filename: fm.filename
      })
    }
  }

  // Non-contiguous order numbers
  if (draft.sequence.length > 0) {
    const orders = draft.sequence.map(s => s.order).sort((a, b) => a - b)
    for (let i = 0; i < orders.length - 1; i++) {
      if (orders[i + 1] - orders[i] > 1) {
        warnings.push({
          type: 'non_contiguous_order',
          message: `Sequence order numbers are not contiguous: gap between ${orders[i]} and ${orders[i + 1]}`,
        })
        break
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

/**
 * Validate an import profile against available files.
 * Returns empty array if valid.
 */
export function validateProfile(
  profile: ImportProfile,
  availableFiles: string[]
): ValidationError[] {
  const errors: ValidationError[] = []

  // Check all mapped files are in sequence
  for (const mapping of profile.mappings) {
    const inSequence = profile.sequence.some(s => s.filename === mapping.filename)
    if (!inSequence) {
      errors.push({
        type: 'sequence_gap',
        message: `File "${mapping.filename}" is mapped but not in sequence`,
        filename: mapping.filename
      })
    }
  }

  // Check all sequence items have a model mapping
  for (const item of profile.sequence) {
    const hasMapping = profile.mappings.some(m => m.filename === item.filename)
    if (!hasMapping) {
      errors.push({
        type: 'missing_model',
        message: `File "${item.filename}" is in sequence but has no model mapping`,
        filename: item.filename
      })
    }
  }

  // Check dependencies are ordered correctly
  const sortedSequence = [...profile.sequence].sort((a, b) => a.order - b.order)
  const processedFiles = new Set<string>()

  for (const item of sortedSequence) {
    if (item.requires) {
      for (const req of item.requires) {
        if (!processedFiles.has(req)) {
          errors.push({
            type: 'dependency_violation',
            message: `"${item.filename}" requires "${req}" which has not been processed yet`,
            filename: item.filename,
            details: `Required file: ${req}`
          })
        }
      }
    }
    processedFiles.add(item.filename)
  }

  // Check for circular dependencies
  const circularErrors = detectCircularDependencies(profile.sequence)
  errors.push(...circularErrors)

  // Check available files match sequence
  for (const item of sortedSequence) {
    const pattern = item.filename.includes('*')
      ? new RegExp('^' + item.filename.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      : null

    const hasMatch = pattern
      ? availableFiles.some(f => pattern.test(f))
      : availableFiles.includes(item.filename)

    if (!hasMatch) {
      errors.push({
        type: 'missing_file',
        message: `Required file "${item.filename}" not found in selected files`,
        filename: item.filename
      })
    }
  }

  return errors
}

/**
 * Detect circular dependencies in the sequence.
 */
function detectCircularDependencies(
  sequence: ImportProfile['sequence']
): ValidationError[] {
  const errors: ValidationError[] = []
  const graph = new Map<string, string[]>()

  for (const item of sequence) {
    graph.set(item.filename, item.requires || [])
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()

  function dfs(node: string, path: string[]): boolean {
    if (visiting.has(node)) {
      errors.push({
        type: 'circular_dependency',
        message: `Circular dependency detected: ${[...path, node].join(' → ')}`,
        filename: node,
        details: path.join(' → ')
      })
      return true
    }

    if (visited.has(node)) return false

    visiting.add(node)
    const deps = graph.get(node) || []

    for (const dep of deps) {
      if (dfs(dep, [...path, node])) return true
    }

    visiting.delete(node)
    visited.add(node)
    return false
  }

  for (const item of sequence) {
    if (!visited.has(item.filename)) {
      dfs(item.filename, [])
    }
  }

  return errors
}

/**
 * Validate that a profile's Odoo version requirement is met.
 */
export function checkVersionCompatibility(
  profile: ImportProfile,
  serverVersion: string | null
): boolean {
  if (!profile.odooMinVersion || !serverVersion) return true

  const minParts = profile.odooMinVersion.split('.').map(Number)
  const serverParts = serverVersion.replace(/[^0-9.]/g, '').split('.').map(Number)

  for (let i = 0; i < Math.max(minParts.length, serverParts.length); i++) {
    const min = minParts[i] || 0
    const server = serverParts[i] || 0
    if (server > min) return true
    if (server < min) return false
  }

  return true
}
