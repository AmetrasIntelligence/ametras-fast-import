/**
 * Shared types for the import system.
 *
 * These types were previously defined across engine.ts, batchExecutor.ts,
 * stateMachine.ts, etc. Now centralized here since the orchestration
 * moved to the Python backend.
 */

/** Import state — mirrors the server's job_state. */
export enum ImportState {
  IDLE = 'idle',
  VALIDATING = 'validating',
  RUNNING_FILE = 'running',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
  INTERRUPTED = 'interrupted',
}

/** Connection status for display. */
export type ConnectionStatus = 'online' | 'offline' | 'checking'

/** A single parsed CSV row. */
export interface ParsedRow {
  index: number
  data: Record<string, string>
  raw?: string[]
}

/** Result for a single row in a batch. */
export interface BatchResult {
  ok: boolean
  error?: string
  rowIndex: number
  createdId?: number
  externalId?: string
}

/** File mapping configuration. */
export interface MappingConfig {
  fieldMappings: Record<string, string>
  idColumn?: 'id' | '.id' | null
  searchKeys?: string[]
  strict?: boolean
}

/** Per-file progress data from the server. */
export interface FileProgress {
  totalRows: number
  processedRows: number
  successCount: number
  failedCount: number
  skipped?: boolean
  processedRanges?: [number, number][]
}

/** Import error entry. */
export interface ImportError {
  filename: string
  rowNumber: number
  rawData: Record<string, string>
  error: string
  timestamp: number
}

/** Resume state from server log. */
export interface ResumeState {
  logId: number
  fileProgress: Record<string, FileProgress>
  errorLog: Array<{ filename: string; rowNumber: number; error: string }>
}

/**
 * Detect which ID column is being used for upsert based on fieldMappings.
 * Returns 'id' for external ID, '.id' for database ID, or null if neither.
 */
export function detectIdColumn(fieldMappings: Record<string, string>): 'id' | '.id' | null {
  for (const odooField of Object.values(fieldMappings)) {
    if (odooField === 'id') return 'id'
    if (odooField === '.id') return '.id'
  }
  return null
}

/** Error thrown when a batch fails due to a network/transient issue. */
export class NetworkBatchError extends Error {
  readonly rows: ParsedRow[]
  constructor(message: string, rows: ParsedRow[]) {
    super(message)
    this.name = 'NetworkBatchError'
    this.rows = rows
  }
}

/** Error thrown when a batch fails due to an authentication issue. */
export class AuthBatchError extends Error {
  readonly rows: ParsedRow[]
  constructor(message: string, rows: ParsedRow[]) {
    super(message)
    this.name = 'AuthBatchError'
    this.rows = rows
  }
}

/** Error thrown when a batch times out. */
export class TimeoutBatchError extends Error {
  readonly rows: ParsedRow[]
  constructor(message: string, rows: ParsedRow[]) {
    super(message)
    this.name = 'TimeoutBatchError'
    this.rows = rows
  }
}
