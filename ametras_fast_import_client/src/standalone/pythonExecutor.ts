/**
 * Python subprocess batch executor.
 *
 * Uses the import_engine Python package (via the python IPC handler) to
 * execute CSV imports with full feature parity:
 * - Search key upsert
 * - Explicit operation column (__op__)
 * - Dry-run validation
 * - Per-row error isolation (savepoints in ORM mode, individual calls in RPC mode)
 * - External ID support
 *
 * Falls back to standalone model.load() mode if Python is unavailable.
 */

import { useSessionStore } from '@/stores/session'
import type { ParsedRow, BatchResult, MappingConfig } from './types'
import { detectIdColumn, NetworkBatchError, AuthBatchError, TimeoutBatchError } from './types'

/**
 * Check if Python import engine is available.
 * Caches the result after first check.
 */
let pythonChecked = false
let pythonAvailable = false
let pythonStarted = false

export async function isPythonAvailable(): Promise<boolean> {
  if (pythonChecked) return pythonAvailable

  try {
    const result = await window.api.python.detect()
    pythonAvailable = result.available
    pythonChecked = true
    return pythonAvailable
  } catch {
    pythonAvailable = false
    pythonChecked = true
    return false
  }
}

/**
 * Ensure Python subprocess is started.
 */
async function ensurePythonStarted(): Promise<void> {
  if (pythonStarted) return

  const result = await window.api.python.start()
  if (!result.ok) {
    throw new Error(`Failed to start Python: ${result.error}`)
  }
  pythonStarted = true
}

/**
 * Execute a batch via the Python import engine subprocess.
 *
 * This function sends raw CSV row data + field mappings to the Python
 * process, which handles transformation, reference resolution, and upsert
 * via XML-RPC to the Odoo server.
 *
 * Matches the ExecuteBatchFn signature from platform.ts.
 */
export async function executePythonBatch(
  model: string,
  rows: ParsedRow[],
  mapping: MappingConfig,
  dryRun?: boolean,
  _signal?: AbortSignal,
): Promise<BatchResult[]> {
  const session = useSessionStore()
  if (!session.baseUrl) throw new Error('Not connected')

  await ensurePythonStarted()

  const idColumn = mapping.idColumn ?? detectIdColumn(mapping.fieldMappings)

  // Credentials are resolved by the main process from saved session — not
  // passed from the renderer (which doesn't have access to raw passwords).
  const result = await window.api.python.import({
    url: session.baseUrl,
    db: session.currentServer?.db,
    model,
    // Send raw CSV data — Python applies field_mappings transformation
    raw_rows: rows.map(row => row.data),
    field_mappings: mapping.fieldMappings,
    use_external_id: idColumn === 'id',
    search_keys: mapping.searchKeys || null,
    dry_run: dryRun || false,
    strict: mapping.strict || false,
  })

  if (result.type === 'error') {
    const msg = result.message || 'Python import failed'

    // Classify errors to match the engine's retry logic
    if (msg.toLowerCase().includes('auth') || msg.toLowerCase().includes('access denied')) {
      throw new AuthBatchError(msg, rows)
    }
    if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('timed out')) {
      throw new TimeoutBatchError(msg, rows)
    }
    if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('connection')) {
      throw new NetworkBatchError(msg, rows)
    }

    // Generic error — return all rows as failed
    return rows.map((row) => ({
      ok: false,
      error: msg,
      rowIndex: row.index,
    }))
  }

  // Map results back to BatchResult format
  if (result.errors && Array.isArray(result.errors)) {
    const errorsByRow = new Map<number, string>()
    for (const err of result.errors as Array<{ row: number; error: string }>) {
      errorsByRow.set(err.row, err.error)
    }

    return rows.map((row) => {
      const error = errorsByRow.get(row.index)
      if (error) {
        return { ok: false, error, rowIndex: row.index }
      }
      return { ok: true, rowIndex: row.index }
    })
  }

  // All succeeded
  return rows.map((row) => ({
    ok: true,
    rowIndex: row.index,
  }))
}

/**
 * Shutdown the Python subprocess.
 * Called on app quit or logout.
 */
export async function shutdownPythonExecutor(): Promise<void> {
  if (pythonStarted) {
    await window.api.python.stop()
    pythonStarted = false
  }
}
