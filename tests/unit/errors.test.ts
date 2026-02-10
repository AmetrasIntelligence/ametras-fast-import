import { describe, it, expect } from 'vitest'
import {
  ImportErrorCode,
  ERROR_SEVERITY,
  createImportError,
  isFatalError,
  isRowError,
  isWarning,
  formatImportError,
  parseOdooError
} from '@/utils/errors'

describe('ImportErrorCode', () => {
  it('has all expected error codes', () => {
    expect(ImportErrorCode.NOT_CONNECTED).toBe('NOT_CONNECTED')
    expect(ImportErrorCode.RECORD_NOT_FOUND).toBe('RECORD_NOT_FOUND')
    expect(ImportErrorCode.EXTERNAL_ID_NOT_FOUND).toBe('EXTERNAL_ID_NOT_FOUND')
    expect(ImportErrorCode.MODEL_MISMATCH).toBe('MODEL_MISMATCH')
  })
})

describe('ERROR_SEVERITY', () => {
  it('maps fatal errors correctly', () => {
    // Only connection/auth errors are fatal (stop entire import)
    expect(ERROR_SEVERITY[ImportErrorCode.NOT_CONNECTED]).toBe('fatal')
    expect(ERROR_SEVERITY[ImportErrorCode.CONNECTION_LOST]).toBe('fatal')
    expect(ERROR_SEVERITY[ImportErrorCode.AUTH_FAILED]).toBe('fatal')
  })

  it('maps configuration errors correctly', () => {
    // Configuration errors skip the file but continue with others
    expect(ERROR_SEVERITY[ImportErrorCode.NO_MAPPING]).toBe('error')
    expect(ERROR_SEVERITY[ImportErrorCode.INVALID_MODEL]).toBe('error')
    expect(ERROR_SEVERITY[ImportErrorCode.INVALID_FIELD]).toBe('error')
  })

  it('maps row errors correctly', () => {
    expect(ERROR_SEVERITY[ImportErrorCode.RECORD_NOT_FOUND]).toBe('error')
    expect(ERROR_SEVERITY[ImportErrorCode.VALIDATION_FAILED]).toBe('error')
    expect(ERROR_SEVERITY[ImportErrorCode.MODEL_MISMATCH]).toBe('error')
  })

  it('maps warnings correctly', () => {
    expect(ERROR_SEVERITY[ImportErrorCode.EXTERNAL_ID_NOT_FOUND]).toBe('warning')
    expect(ERROR_SEVERITY[ImportErrorCode.SEARCH_KEY_NOT_FOUND]).toBe('warning')
  })
})

describe('createImportError', () => {
  it('creates error with correct severity from code', () => {
    const error = createImportError(
      ImportErrorCode.NOT_CONNECTED,
      'Connection lost'
    )
    expect(error.code).toBe(ImportErrorCode.NOT_CONNECTED)
    expect(error.severity).toBe('fatal')
    expect(error.message).toBe('Connection lost')
  })

  it('includes context when provided', () => {
    const error = createImportError(
      ImportErrorCode.VALIDATION_FAILED,
      'Invalid value',
      { filename: 'test.csv', rowNumber: 5, field: 'name' }
    )
    expect(error.context?.filename).toBe('test.csv')
    expect(error.context?.rowNumber).toBe(5)
    expect(error.context?.field).toBe('name')
  })

  it('includes details when provided', () => {
    const error = createImportError(
      ImportErrorCode.UNKNOWN,
      'Something went wrong',
      undefined,
      'Stack trace here'
    )
    expect(error.details).toBe('Stack trace here')
  })
})

describe('error classification helpers', () => {
  it('isFatalError returns true for fatal errors', () => {
    const error = createImportError(ImportErrorCode.NOT_CONNECTED, 'Test')
    expect(isFatalError(error)).toBe(true)
  })

  it('isFatalError returns false for non-fatal errors', () => {
    const error = createImportError(ImportErrorCode.RECORD_NOT_FOUND, 'Test')
    expect(isFatalError(error)).toBe(false)
  })

  it('isRowError returns true for row-level errors', () => {
    const error = createImportError(ImportErrorCode.VALIDATION_FAILED, 'Test')
    expect(isRowError(error)).toBe(true)
  })

  it('isWarning returns true for warnings', () => {
    const error = createImportError(ImportErrorCode.EXTERNAL_ID_NOT_FOUND, 'Test')
    expect(isWarning(error)).toBe(true)
  })
})

describe('formatImportError', () => {
  it('formats error with code and message', () => {
    const error = createImportError(
      ImportErrorCode.VALIDATION_FAILED,
      'Name is required'
    )
    const formatted = formatImportError(error)
    expect(formatted).toContain('[VALIDATION_FAILED]')
    expect(formatted).toContain('Name is required')
  })

  it('includes filename and row number in context', () => {
    const error = createImportError(
      ImportErrorCode.INVALID_VALUE,
      'Invalid date format',
      { filename: 'partners.csv', rowNumber: 42 }
    )
    const formatted = formatImportError(error)
    expect(formatted).toContain('partners.csv')
    expect(formatted).toContain('row 42')
  })

  it('includes field name when present', () => {
    const error = createImportError(
      ImportErrorCode.REQUIRED_FIELD_MISSING,
      'Field is required',
      { field: 'email' }
    )
    const formatted = formatImportError(error)
    expect(formatted).toContain('field "email"')
  })

  it('includes details when present', () => {
    const error = createImportError(
      ImportErrorCode.UNKNOWN,
      'Error occurred',
      undefined,
      'Additional info'
    )
    const formatted = formatImportError(error)
    expect(formatted).toContain('(Additional info)')
  })
})

describe('parseOdooError', () => {
  it('parses string error with "not found" as RECORD_NOT_FOUND', () => {
    const error = parseOdooError('Record 123 not found')
    expect(error.code).toBe(ImportErrorCode.RECORD_NOT_FOUND)
  })

  it('parses string error with "External ID" as EXTERNAL_ID_NOT_FOUND', () => {
    const error = parseOdooError('External ID product.abc does not exist')
    expect(error.code).toBe(ImportErrorCode.EXTERNAL_ID_NOT_FOUND)
  })

  it('parses string error with "duplicate" as DUPLICATE_RECORD', () => {
    const error = parseOdooError('Record already exists (duplicate)')
    expect(error.code).toBe(ImportErrorCode.DUPLICATE_RECORD)
  })

  it('parses string error with "constraint" as CONSTRAINT_VIOLATION', () => {
    const error = parseOdooError('UNIQUE constraint violation')
    expect(error.code).toBe(ImportErrorCode.CONSTRAINT_VIOLATION)
  })

  it('parses string error with "required" as REQUIRED_FIELD_MISSING', () => {
    const error = parseOdooError('Field "name" is required')
    expect(error.code).toBe(ImportErrorCode.REQUIRED_FIELD_MISSING)
  })

  it('parses string error with "invalid" as INVALID_VALUE', () => {
    const error = parseOdooError('Invalid value for field')
    expect(error.code).toBe(ImportErrorCode.INVALID_VALUE)
  })

  it('parses Error object', () => {
    const error = parseOdooError(new Error('Something went wrong'))
    expect(error.message).toBe('Something went wrong')
  })

  it('parses unknown error type', () => {
    const error = parseOdooError({ foo: 'bar' })
    expect(error.code).toBe(ImportErrorCode.UNKNOWN)
  })

  it('includes context when provided', () => {
    const error = parseOdooError('Test error', { filename: 'test.csv', rowNumber: 10 })
    expect(error.context?.filename).toBe('test.csv')
    expect(error.context?.rowNumber).toBe(10)
  })
})
