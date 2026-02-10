/**
 * Error severity levels for consistent handling.
 * - fatal: Stop import immediately
 * - error: Log and continue, but mark row as failed
 * - warning: Log and continue normally
 * - info: Informational, no action needed
 */
export type ErrorSeverity = 'fatal' | 'error' | 'warning' | 'info'

/**
 * Error codes for categorizing import errors.
 */
export enum ImportErrorCode {
  // Connection errors (fatal)
  NOT_CONNECTED = 'NOT_CONNECTED',
  CONNECTION_LOST = 'CONNECTION_LOST',
  AUTH_FAILED = 'AUTH_FAILED',

  // Configuration errors (file fails, continue with next)
  NO_MAPPING = 'NO_MAPPING',
  INVALID_MODEL = 'INVALID_MODEL',
  INVALID_FIELD = 'INVALID_FIELD',
  INVALID_TRANSFORM = 'INVALID_TRANSFORM',

  // Data errors (error - row fails)
  RECORD_NOT_FOUND = 'RECORD_NOT_FOUND',
  DUPLICATE_RECORD = 'DUPLICATE_RECORD',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  CONSTRAINT_VIOLATION = 'CONSTRAINT_VIOLATION',
  REQUIRED_FIELD_MISSING = 'REQUIRED_FIELD_MISSING',
  INVALID_VALUE = 'INVALID_VALUE',
  REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND',

  // Reference warnings (warning - continue)
  EXTERNAL_ID_NOT_FOUND = 'EXTERNAL_ID_NOT_FOUND',
  SEARCH_KEY_NOT_FOUND = 'SEARCH_KEY_NOT_FOUND',
  AMBIGUOUS_REFERENCE = 'AMBIGUOUS_REFERENCE',

  // Model mismatches (error)
  MODEL_MISMATCH = 'MODEL_MISMATCH',
  FIELD_TYPE_MISMATCH = 'FIELD_TYPE_MISMATCH',

  // System errors
  TIMEOUT = 'TIMEOUT',
  NETWORK_ERROR = 'NETWORK_ERROR',
  UNKNOWN = 'UNKNOWN'
}

/**
 * Maps error codes to their default severity.
 */
export const ERROR_SEVERITY: Record<ImportErrorCode, ErrorSeverity> = {
  // Fatal errors - stop import (only connection/auth issues)
  [ImportErrorCode.NOT_CONNECTED]: 'fatal',
  [ImportErrorCode.CONNECTION_LOST]: 'fatal',
  [ImportErrorCode.AUTH_FAILED]: 'fatal',

  // Configuration errors - log error, continue with next file
  [ImportErrorCode.NO_MAPPING]: 'error',
  [ImportErrorCode.INVALID_MODEL]: 'error',
  [ImportErrorCode.INVALID_FIELD]: 'error',
  [ImportErrorCode.INVALID_TRANSFORM]: 'error',

  // Row errors - mark row as failed
  [ImportErrorCode.RECORD_NOT_FOUND]: 'error',
  [ImportErrorCode.DUPLICATE_RECORD]: 'error',
  [ImportErrorCode.VALIDATION_FAILED]: 'error',
  [ImportErrorCode.CONSTRAINT_VIOLATION]: 'error',
  [ImportErrorCode.REQUIRED_FIELD_MISSING]: 'error',
  [ImportErrorCode.INVALID_VALUE]: 'error',
  [ImportErrorCode.REFERENCE_NOT_FOUND]: 'error',
  [ImportErrorCode.MODEL_MISMATCH]: 'error',
  [ImportErrorCode.FIELD_TYPE_MISMATCH]: 'error',

  // Warnings - log and continue
  [ImportErrorCode.EXTERNAL_ID_NOT_FOUND]: 'warning',
  [ImportErrorCode.SEARCH_KEY_NOT_FOUND]: 'warning',
  [ImportErrorCode.AMBIGUOUS_REFERENCE]: 'warning',

  // System errors
  [ImportErrorCode.TIMEOUT]: 'error',
  [ImportErrorCode.NETWORK_ERROR]: 'error',
  [ImportErrorCode.UNKNOWN]: 'error'
}

/**
 * Structured import error with code, severity, and context.
 */
export interface ImportError {
  code: ImportErrorCode
  severity: ErrorSeverity
  message: string
  details?: string
  context?: {
    filename?: string
    rowNumber?: number
    field?: string
    model?: string
    value?: unknown
  }
}

/**
 * Create a structured import error.
 */
export function createImportError(
  code: ImportErrorCode,
  message: string,
  context?: ImportError['context'],
  details?: string
): ImportError {
  return {
    code,
    severity: ERROR_SEVERITY[code],
    message,
    details,
    context
  }
}

/**
 * Check if an error should stop the import.
 */
export function isFatalError(error: ImportError): boolean {
  return error.severity === 'fatal'
}

/**
 * Check if an error should mark the row as failed.
 */
export function isRowError(error: ImportError): boolean {
  return error.severity === 'error'
}

/**
 * Check if an error is just a warning.
 */
export function isWarning(error: ImportError): boolean {
  return error.severity === 'warning'
}

/**
 * Format error for display.
 */
export function formatImportError(error: ImportError): string {
  const parts: string[] = []

  // Severity prefix
  const severityIcon = {
    fatal: '\u2718',    // ✘
    error: '\u2717',    // ✗
    warning: '\u26A0',  // ⚠
    info: '\u2139'      // ℹ
  }[error.severity]

  parts.push(`${severityIcon} [${error.code}]`)

  // Context
  if (error.context?.filename) {
    parts.push(`${error.context.filename}`)
  }
  if (error.context?.rowNumber !== undefined) {
    parts.push(`row ${error.context.rowNumber}`)
  }
  if (error.context?.field) {
    parts.push(`field "${error.context.field}"`)
  }

  // Message
  parts.push(`- ${error.message}`)

  // Details
  if (error.details) {
    parts.push(`(${error.details})`)
  }

  return parts.join(' ')
}

/**
 * Parse Odoo error response to ImportError.
 */
export function parseOdooError(
  error: unknown,
  context?: ImportError['context']
): ImportError {
  if (typeof error === 'string') {
    // Check for common Odoo error patterns
    if (error.includes('does not exist') || error.includes('not found')) {
      if (error.includes('External ID')) {
        return createImportError(
          ImportErrorCode.EXTERNAL_ID_NOT_FOUND,
          error,
          context
        )
      }
      return createImportError(
        ImportErrorCode.RECORD_NOT_FOUND,
        error,
        context
      )
    }

    if (error.includes('already exists') || error.includes('duplicate')) {
      return createImportError(
        ImportErrorCode.DUPLICATE_RECORD,
        error,
        context
      )
    }

    if (error.includes('constraint') || error.includes('UNIQUE')) {
      return createImportError(
        ImportErrorCode.CONSTRAINT_VIOLATION,
        error,
        context
      )
    }

    if (error.includes('required') || error.includes('missing')) {
      return createImportError(
        ImportErrorCode.REQUIRED_FIELD_MISSING,
        error,
        context
      )
    }

    if (error.includes('invalid') || error.includes('Invalid')) {
      return createImportError(
        ImportErrorCode.INVALID_VALUE,
        error,
        context
      )
    }

    return createImportError(
      ImportErrorCode.UNKNOWN,
      error,
      context
    )
  }

  if (error instanceof Error) {
    return createImportError(
      ImportErrorCode.UNKNOWN,
      error.message,
      context,
      error.stack
    )
  }

  return createImportError(
    ImportErrorCode.UNKNOWN,
    'Unknown error occurred',
    context,
    JSON.stringify(error)
  )
}
