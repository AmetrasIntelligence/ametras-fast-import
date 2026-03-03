import { describe, it, expect } from 'vitest'
import {
  ImportErrorCode,
  ERROR_SEVERITY,
  ERROR_CATEGORY,
  createImportError,
  isFatalError,
  isRowError,
  isWarning,
  isNetworkError,
  isNetworkErrorCode,
  classifyFetchError,
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

describe('ERROR_CATEGORY', () => {
  it('maps network/transient errors to network category', () => {
    expect(ERROR_CATEGORY[ImportErrorCode.TIMEOUT]).toBe('network')
    expect(ERROR_CATEGORY[ImportErrorCode.NETWORK_ERROR]).toBe('network')
    expect(ERROR_CATEGORY[ImportErrorCode.CONNECTION_LOST]).toBe('network')
  })

  it('maps auth errors to auth category', () => {
    expect(ERROR_CATEGORY[ImportErrorCode.NOT_CONNECTED]).toBe('auth')
    expect(ERROR_CATEGORY[ImportErrorCode.AUTH_FAILED]).toBe('auth')
  })

  it('maps config errors to config category', () => {
    expect(ERROR_CATEGORY[ImportErrorCode.NO_MAPPING]).toBe('config')
    expect(ERROR_CATEGORY[ImportErrorCode.INVALID_MODEL]).toBe('config')
    expect(ERROR_CATEGORY[ImportErrorCode.INVALID_FIELD]).toBe('config')
    expect(ERROR_CATEGORY[ImportErrorCode.INVALID_TRANSFORM]).toBe('config')
  })

  it('maps data errors to data category', () => {
    expect(ERROR_CATEGORY[ImportErrorCode.RECORD_NOT_FOUND]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.DUPLICATE_RECORD]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.VALIDATION_FAILED]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.CONSTRAINT_VIOLATION]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.REQUIRED_FIELD_MISSING]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.INVALID_VALUE]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.UNKNOWN]).toBe('data')
  })

  it('has a mapping for every ImportErrorCode', () => {
    for (const code of Object.values(ImportErrorCode)) {
      expect(ERROR_CATEGORY[code]).toBeDefined()
    }
  })
})

describe('isNetworkErrorCode', () => {
  it('returns true for TIMEOUT', () => {
    expect(isNetworkErrorCode(ImportErrorCode.TIMEOUT)).toBe(true)
  })

  it('returns true for NETWORK_ERROR', () => {
    expect(isNetworkErrorCode(ImportErrorCode.NETWORK_ERROR)).toBe(true)
  })

  it('returns true for CONNECTION_LOST', () => {
    expect(isNetworkErrorCode(ImportErrorCode.CONNECTION_LOST)).toBe(true)
  })

  it('returns false for data errors', () => {
    expect(isNetworkErrorCode(ImportErrorCode.VALIDATION_FAILED)).toBe(false)
    expect(isNetworkErrorCode(ImportErrorCode.RECORD_NOT_FOUND)).toBe(false)
    expect(isNetworkErrorCode(ImportErrorCode.UNKNOWN)).toBe(false)
  })

  it('returns false for auth errors', () => {
    expect(isNetworkErrorCode(ImportErrorCode.AUTH_FAILED)).toBe(false)
    expect(isNetworkErrorCode(ImportErrorCode.NOT_CONNECTED)).toBe(false)
  })
})

describe('isNetworkError', () => {
  it('returns true for network error codes', () => {
    const error = createImportError(ImportErrorCode.NETWORK_ERROR, 'Server unavailable')
    expect(isNetworkError(error)).toBe(true)
  })

  it('returns true for timeout errors', () => {
    const error = createImportError(ImportErrorCode.TIMEOUT, 'Request timed out')
    expect(isNetworkError(error)).toBe(true)
  })

  it('returns false for data errors', () => {
    const error = createImportError(ImportErrorCode.VALIDATION_FAILED, 'Invalid data')
    expect(isNetworkError(error)).toBe(false)
  })

  it('returns false for fatal auth errors', () => {
    const error = createImportError(ImportErrorCode.AUTH_FAILED, 'Auth failed')
    expect(isNetworkError(error)).toBe(false)
  })
})

describe('classifyFetchError', () => {
  it('classifies DOMException AbortError as TIMEOUT', () => {
    const error = new DOMException('The operation was aborted', 'AbortError')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.TIMEOUT)
  })

  it('classifies TypeError as NETWORK_ERROR (fetch DNS/connection failure)', () => {
    const error = new TypeError('Failed to fetch')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.NETWORK_ERROR)
  })

  it('classifies error with "timeout" in message as TIMEOUT', () => {
    const error = new Error('Request timeout after 30s')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.TIMEOUT)
  })

  it('classifies error with "timed out" in message as TIMEOUT', () => {
    const error = new Error('Connection timed out')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.TIMEOUT)
  })

  it('classifies error with "502" in message as NETWORK_ERROR', () => {
    const error = new Error('HTTP 502 Bad Gateway')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.NETWORK_ERROR)
  })

  it('classifies error with "503" in message as NETWORK_ERROR', () => {
    const error = new Error('503 Service Unavailable')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.NETWORK_ERROR)
  })

  it('classifies error with "504" in message as NETWORK_ERROR', () => {
    const error = new Error('HTTP 504 response from server')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.NETWORK_ERROR)
  })

  it('classifies "gateway timeout" text as TIMEOUT (timeout keyword takes priority)', () => {
    // "504 Gateway Timeout" contains "timeout" which matches the timeout check first
    const error = new Error('504 Gateway Timeout')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.TIMEOUT)
  })

  it('classifies error with "bad gateway" in message as NETWORK_ERROR', () => {
    const error = new Error('bad gateway from upstream')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.NETWORK_ERROR)
  })

  it('classifies error with "service unavailable" in message as NETWORK_ERROR', () => {
    const error = new Error('service unavailable')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.NETWORK_ERROR)
  })

  it('classifies error with "failed to fetch" in message as NETWORK_ERROR', () => {
    const error = new Error('failed to fetch resource')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.NETWORK_ERROR)
  })

  it('classifies error with "net::" in message as NETWORK_ERROR', () => {
    const error = new Error('net::ERR_CONNECTION_REFUSED')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.NETWORK_ERROR)
  })

  it('classifies unknown Error as UNKNOWN', () => {
    const error = new Error('Something completely different')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.UNKNOWN)
  })

  it('classifies non-Error values as UNKNOWN', () => {
    expect(classifyFetchError('string error')).toBe(ImportErrorCode.UNKNOWN)
    expect(classifyFetchError(42)).toBe(ImportErrorCode.UNKNOWN)
    expect(classifyFetchError(null)).toBe(ImportErrorCode.UNKNOWN)
    expect(classifyFetchError(undefined)).toBe(ImportErrorCode.UNKNOWN)
  })

  it('prioritizes DOMException AbortError over message content', () => {
    // AbortError is always TIMEOUT, even if message contains "network"
    const error = new DOMException('network abort', 'AbortError')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.TIMEOUT)
  })

  it('prioritizes TypeError over message content', () => {
    // TypeError is always NETWORK_ERROR, even if message contains "timeout"
    const error = new TypeError('timeout while connecting')
    expect(classifyFetchError(error)).toBe(ImportErrorCode.NETWORK_ERROR)
  })
})
