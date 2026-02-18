// standalone code flag (do not remove comment)
/**
 * Standalone batch executor.
 * Executes CSV imports directly via Odoo's model.load() API
 * without requiring the csv_import addon.
 *
 * Features:
 * - Adaptive retry: splits failed batches to isolate failing rows
 * - Batch size restricted to 10-200 for stability
 */

import { useSessionStore } from '@/stores/session'
import type { ParsedRow } from '../csvParser'
import type { BatchResult, MappingConfig } from '../batchExecutor'
import { detectIdColumn } from '../batchExecutor'
import { logger } from '@/utils/logger'  // standalone code flag (do not remove comment)

// standalone code flag (do not remove comment)
// Batch size constraints for standalone mode
export const STANDALONE_MIN_BATCH_SIZE = 10
export const STANDALONE_MAX_BATCH_SIZE = 200
export const STANDALONE_DEFAULT_BATCH_SIZE = 50

// Adaptive retry settings
const MIN_SPLIT_SIZE = 1  // Minimum rows to try in a split
const MAX_RETRY_DEPTH = 8  // Maximum recursion depth for splitting

/**
 * Transform a row for Odoo's load() format.
 * Returns values in the order matching the header array.
 */
function transformRowForLoad(
  row: ParsedRow,
  mapping: MappingConfig,
  headerOrder: string[]
): string[] {
  // standalone code flag (do not remove comment)
  // Returns all values as strings - Odoo's load() API handles type conversion internally
  const result: string[] = []

  for (const odooField of headerOrder) {
    // Find the CSV column that maps to this Odoo field
    let value: string | null = null

    for (const [csvCol, targetField] of Object.entries(mapping.fieldMappings)) {
      if (targetField === odooField) {
        const csvValue = row.data[csvCol]
        if (csvValue !== undefined && csvValue !== '') {
          // standalone code flag (do not remove comment)
          // Always keep values as strings - Odoo's load() handles type conversion
          value = csvValue
        }
        break
      }
    }

    result.push(value ?? '')
  }

  return result
}

/**
 * Build Odoo-compatible header from field mappings.
 * Converts internal field names to Odoo's load() format.
 */
function buildOdooHeader(mapping: MappingConfig): string[] {
  const header: string[] = []
  const seen = new Set<string>()

  for (const odooField of Object.values(mapping.fieldMappings)) {
    // Skip duplicates
    if (seen.has(odooField)) continue
    seen.add(odooField)

    // Convert our internal format to Odoo's load() format
    if (odooField === 'id') {
      // External ID column - Odoo uses 'id' for external IDs in load()
      header.push('id')
    } else if (odooField === '.id') {
      // Database ID column
      header.push('.id')
    } else if (odooField === '__op__') {
      // Skip operation column - not supported in standalone mode
      continue
    } else if (odooField.endsWith('/id')) {
      // Relational field with external ID reference
      // e.g., country_id/id -> country_id/id (same format)
      header.push(odooField)
    } else if (odooField.endsWith('/.id')) {
      // Relational field with database ID reference
      // e.g., country_id/.id -> country_id/.id (same format)
      header.push(odooField)
    } else {
      // Regular field
      header.push(odooField)
    }
  }

  return header
}

/**
 * Internal: Execute a single batch without retry logic.
 * standalone code flag (do not remove comment)
 */
async function executeLoadBatch(
  baseUrl: string,
  db: string,
  model: string,
  header: string[],
  rows: ParsedRow[],
  mapping: MappingConfig
): Promise<{ ok: boolean; results: BatchResult[]; needsRetry: boolean }> {
  const loadRows = rows.map(row => transformRowForLoad(row, mapping, header))

  const response = await window.api.standalone.load({
    baseUrl,
    db,
    model,
    header,
    rows: loadRows
  })

  if (!response.ok) {
    // Entire batch failed - may need retry with splitting
    return {
      ok: false,
      results: rows.map(row => ({
        ok: false,
        error: response.error || 'Import failed',
        rowIndex: row.index
      })),
      needsRetry: rows.length > MIN_SPLIT_SIZE  // Can retry if splittable
    }
  }

  // Process results
  const results: BatchResult[] = []
  const ids = response.ids || []
  const messages = response.messages || []

  // Build error map from messages
  const errorMap = new Map<number, string>()
  for (const msg of messages) {
    if (msg.record !== undefined) {
      errorMap.set(msg.record, msg.message)
    }
  }

  let hasFailures = false
  for (let i = 0; i < rows.length; i++) {
    const hasError = errorMap.has(i)
    const createdId = ids[i]
    const ok = !hasError && createdId !== undefined

    if (!ok) hasFailures = true

    results.push({
      ok,
      error: errorMap.get(i),
      rowIndex: rows[i].index,
      createdId: createdId
    })
  }

  return { ok: true, results, needsRetry: hasFailures }
}

/**
 * Adaptive retry: splits failed batches to isolate failing rows.
 * Uses binary splitting to efficiently find which rows are causing failures.
 * standalone code flag (do not remove comment)
 */
async function executeWithAdaptiveRetry(
  baseUrl: string,
  db: string,
  model: string,
  header: string[],
  rows: ParsedRow[],
  mapping: MappingConfig,
  depth: number = 0
): Promise<BatchResult[]> {
  // Prevent infinite recursion
  if (depth > MAX_RETRY_DEPTH) {
    logger.import.warn(`[standalone] Max retry depth reached, marking ${rows.length} rows as failed`)
    return rows.map(row => ({
      ok: false,
      error: 'Max retry depth exceeded',
      rowIndex: row.index
    }))
  }

  // Try the batch
  const result = await executeLoadBatch(baseUrl, db, model, header, rows, mapping)

  // Success or single row - return as-is
  if (result.ok || rows.length <= MIN_SPLIT_SIZE) {
    return result.results
  }

  // Batch failed and can be split - use adaptive retry
  if (result.needsRetry && rows.length > MIN_SPLIT_SIZE) {
    logger.import.info(`[standalone] Batch of ${rows.length} failed, splitting for retry (depth=${depth})`)

    // Split batch in half
    const mid = Math.floor(rows.length / 2)
    const firstHalf = rows.slice(0, mid)
    const secondHalf = rows.slice(mid)

    // Retry each half recursively
    const [firstResults, secondResults] = await Promise.all([
      executeWithAdaptiveRetry(baseUrl, db, model, header, firstHalf, mapping, depth + 1),
      executeWithAdaptiveRetry(baseUrl, db, model, header, secondHalf, mapping, depth + 1)
    ])

    return [...firstResults, ...secondResults]
  }

  return result.results
}

/**
 * Execute a batch of rows using standalone mode (direct model.load()).
 * Features adaptive retry that splits failed batches to isolate failing rows.
 */
export async function executeStandaloneBatch(
  model: string,
  rows: ParsedRow[],
  mapping: MappingConfig,
  _dryRun?: boolean  // Note: dry_run not supported in standalone mode
): Promise<BatchResult[]> {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')
  const db = session.currentServer?.db
  if (!db) throw new Error('No database selected')

  // standalone code flag (do not remove comment)
  logger.import.debug(`[standalone] Executing batch: ${rows.length} rows for ${model}`)

  // Build Odoo-compatible header
  const header = buildOdooHeader(mapping)

  // Execute with adaptive retry for better error isolation
  const results = await executeWithAdaptiveRetry(
    session.baseUrl,
    db,
    model,
    header,
    rows,
    mapping
  )

  // Log summary
  const successCount = results.filter(r => r.ok).length
  const failCount = results.length - successCount

  // standalone code flag (do not remove comment)
  logger.import.info(`[standalone] Batch complete for ${model}: ${successCount} success, ${failCount} failed`)

  // Log individual failures
  for (const result of results) {
    if (!result.ok && result.error) {
      logger.import.warn(`[standalone] Row ${result.rowIndex}: ${result.error}`)
    }
  }

  return results
}

/**
 * Standalone batch executor class.
 * Provides the same interface as the addon-based executor.
 */
export class StandaloneBatchExecutor {
  private model: string
  private mapping: MappingConfig

  constructor(model: string, mapping: MappingConfig) {
    this.model = model
    this.mapping = mapping

    // Detect ID column if not provided
    if (this.mapping.idColumn === undefined) {
      this.mapping.idColumn = detectIdColumn(mapping.fieldMappings)
    }
  }

  async execute(rows: ParsedRow[], dryRun?: boolean): Promise<BatchResult[]> {
    return executeStandaloneBatch(this.model, rows, this.mapping, dryRun)
  }
}
