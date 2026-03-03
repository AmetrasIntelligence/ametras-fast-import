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

describe('ERROR_SEVERITY', () => {
  it('maps all codes to correct severity', () => {
    const cases: [ImportErrorCode, string][] = [
      [ImportErrorCode.NOT_CONNECTED, 'fatal'],
      [ImportErrorCode.CONNECTION_LOST, 'fatal'],
      [ImportErrorCode.AUTH_FAILED, 'fatal'],
      [ImportErrorCode.NO_MAPPING, 'error'],
      [ImportErrorCode.INVALID_MODEL, 'error'],
      [ImportErrorCode.INVALID_FIELD, 'error'],
      [ImportErrorCode.RECORD_NOT_FOUND, 'error'],
      [ImportErrorCode.VALIDATION_FAILED, 'error'],
      [ImportErrorCode.MODEL_MISMATCH, 'error'],
      [ImportErrorCode.EXTERNAL_ID_NOT_FOUND, 'warning'],
      [ImportErrorCode.SEARCH_KEY_NOT_FOUND, 'warning'],
    ]
    for (const [code, severity] of cases) {
      expect(ERROR_SEVERITY[code]).toBe(severity)
    }
  })
})

describe('createImportError', () => {
  it('creates error with severity, context, and details', () => {
    const error = createImportError(ImportErrorCode.NOT_CONNECTED, 'Connection lost')
    expect(error.code).toBe(ImportErrorCode.NOT_CONNECTED)
    expect(error.severity).toBe('fatal')
    expect(error.message).toBe('Connection lost')

    const withContext = createImportError(
      ImportErrorCode.VALIDATION_FAILED, 'Invalid value',
      { filename: 'test.csv', rowNumber: 5, field: 'name' }
    )
    expect(withContext.context?.filename).toBe('test.csv')
    expect(withContext.context?.rowNumber).toBe(5)
    expect(withContext.context?.field).toBe('name')

    const withDetails = createImportError(
      ImportErrorCode.UNKNOWN, 'Something went wrong', undefined, 'Stack trace here'
    )
    expect(withDetails.details).toBe('Stack trace here')
  })
})

describe('error classification helpers', () => {
  it('classifies errors by severity', () => {
    expect(isFatalError(createImportError(ImportErrorCode.NOT_CONNECTED, 'Test'))).toBe(true)
    expect(isFatalError(createImportError(ImportErrorCode.RECORD_NOT_FOUND, 'Test'))).toBe(false)
    expect(isRowError(createImportError(ImportErrorCode.VALIDATION_FAILED, 'Test'))).toBe(true)
    expect(isWarning(createImportError(ImportErrorCode.EXTERNAL_ID_NOT_FOUND, 'Test'))).toBe(true)
  })
})

describe('formatImportError', () => {
  it('formats errors with all context', () => {
    const cases: [ReturnType<typeof createImportError>, string[]][] = [
      [
        createImportError(ImportErrorCode.VALIDATION_FAILED, 'Name is required'),
        ['[VALIDATION_FAILED]', 'Name is required'],
      ],
      [
        createImportError(ImportErrorCode.INVALID_VALUE, 'Invalid date format', { filename: 'partners.csv', rowNumber: 42 }),
        ['partners.csv', 'row 42'],
      ],
      [
        createImportError(ImportErrorCode.REQUIRED_FIELD_MISSING, 'Field is required', { field: 'email' }),
        ['field "email"'],
      ],
      [
        createImportError(ImportErrorCode.UNKNOWN, 'Error occurred', undefined, 'Additional info'),
        ['(Additional info)'],
      ],
    ]
    for (const [error, expectedSubstrings] of cases) {
      const formatted = formatImportError(error)
      for (const sub of expectedSubstrings) {
        expect(formatted).toContain(sub)
      }
    }
  })
})

describe('parseOdooError', () => {
  it('parses string errors by pattern', () => {
    const cases: [string, ImportErrorCode][] = [
      ['Record 123 not found', ImportErrorCode.RECORD_NOT_FOUND],
      ['External ID product.abc does not exist', ImportErrorCode.EXTERNAL_ID_NOT_FOUND],
      ['Record already exists (duplicate)', ImportErrorCode.DUPLICATE_RECORD],
      ['UNIQUE constraint violation', ImportErrorCode.CONSTRAINT_VIOLATION],
      ['Field "name" is required', ImportErrorCode.REQUIRED_FIELD_MISSING],
      ['Invalid value for field', ImportErrorCode.INVALID_VALUE],
    ]
    for (const [input, expectedCode] of cases) {
      expect(parseOdooError(input).code).toBe(expectedCode)
    }
  })

  it('parses Error objects, unknown types, and includes context', () => {
    expect(parseOdooError(new Error('Something went wrong')).message).toBe('Something went wrong')
    expect(parseOdooError({ foo: 'bar' }).code).toBe(ImportErrorCode.UNKNOWN)

    const error = parseOdooError('Test error', { filename: 'test.csv', rowNumber: 10 })
    expect(error.context?.filename).toBe('test.csv')
    expect(error.context?.rowNumber).toBe(10)
  })
})

describe('ERROR_CATEGORY', () => {
  it('maps all codes to correct categories', () => {
    expect(ERROR_CATEGORY[ImportErrorCode.TIMEOUT]).toBe('network')
    expect(ERROR_CATEGORY[ImportErrorCode.NETWORK_ERROR]).toBe('network')
    expect(ERROR_CATEGORY[ImportErrorCode.CONNECTION_LOST]).toBe('network')
    expect(ERROR_CATEGORY[ImportErrorCode.NOT_CONNECTED]).toBe('auth')
    expect(ERROR_CATEGORY[ImportErrorCode.AUTH_FAILED]).toBe('auth')
    expect(ERROR_CATEGORY[ImportErrorCode.NO_MAPPING]).toBe('config')
    expect(ERROR_CATEGORY[ImportErrorCode.INVALID_MODEL]).toBe('config')
    expect(ERROR_CATEGORY[ImportErrorCode.INVALID_FIELD]).toBe('config')
    expect(ERROR_CATEGORY[ImportErrorCode.INVALID_TRANSFORM]).toBe('config')
    expect(ERROR_CATEGORY[ImportErrorCode.RECORD_NOT_FOUND]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.DUPLICATE_RECORD]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.VALIDATION_FAILED]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.CONSTRAINT_VIOLATION]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.REQUIRED_FIELD_MISSING]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.INVALID_VALUE]).toBe('data')
    expect(ERROR_CATEGORY[ImportErrorCode.UNKNOWN]).toBe('data')

    for (const code of Object.values(ImportErrorCode)) {
      expect(ERROR_CATEGORY[code]).toBeDefined()
    }
  })
})

describe('isNetworkErrorCode / isNetworkError', () => {
  it('identifies network error codes and errors', () => {
    const cases: [ImportErrorCode, boolean][] = [
      [ImportErrorCode.TIMEOUT, true],
      [ImportErrorCode.NETWORK_ERROR, true],
      [ImportErrorCode.CONNECTION_LOST, true],
      [ImportErrorCode.VALIDATION_FAILED, false],
      [ImportErrorCode.RECORD_NOT_FOUND, false],
      [ImportErrorCode.UNKNOWN, false],
      [ImportErrorCode.AUTH_FAILED, false],
      [ImportErrorCode.NOT_CONNECTED, false],
    ]
    for (const [code, expected] of cases) {
      expect(isNetworkErrorCode(code)).toBe(expected)
      expect(isNetworkError(createImportError(code, 'Test'))).toBe(expected)
    }
  })
})

describe('classifyFetchError', () => {
  it('classifies all error types', () => {
    const cases: [unknown, ImportErrorCode][] = [
      [new DOMException('The operation was aborted', 'AbortError'), ImportErrorCode.TIMEOUT],
      [new TypeError('Failed to fetch'), ImportErrorCode.NETWORK_ERROR],
      [new Error('Request timeout after 30s'), ImportErrorCode.TIMEOUT],
      [new Error('Connection timed out'), ImportErrorCode.TIMEOUT],
      [new Error('HTTP 502 Bad Gateway'), ImportErrorCode.NETWORK_ERROR],
      [new Error('503 Service Unavailable'), ImportErrorCode.NETWORK_ERROR],
      [new Error('HTTP 504 response from server'), ImportErrorCode.NETWORK_ERROR],
      [new Error('504 Gateway Timeout'), ImportErrorCode.TIMEOUT],
      [new Error('bad gateway from upstream'), ImportErrorCode.NETWORK_ERROR],
      [new Error('service unavailable'), ImportErrorCode.NETWORK_ERROR],
      [new Error('failed to fetch resource'), ImportErrorCode.NETWORK_ERROR],
      [new Error('net::ERR_CONNECTION_REFUSED'), ImportErrorCode.NETWORK_ERROR],
      [new Error('Something completely different'), ImportErrorCode.UNKNOWN],
      [new DOMException('network abort', 'AbortError'), ImportErrorCode.TIMEOUT],
      [new TypeError('timeout while connecting'), ImportErrorCode.NETWORK_ERROR],
    ]
    for (const [error, expected] of cases) {
      expect(classifyFetchError(error)).toBe(expected)
    }
  })

  it('classifies non-Error values as UNKNOWN', () => {
    for (const value of ['string error', 42, null, undefined]) {
      expect(classifyFetchError(value)).toBe(ImportErrorCode.UNKNOWN)
    }
  })
})
