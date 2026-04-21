export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

/**
 * Standard log categories for consistent filtering.
 */
export enum LogCategory {
  IMPORT = 'import',
  CSV = 'csv',
  API = 'api',
  PROFILE = 'profile',
  WORKER = 'worker',
  VALIDATION = 'validation',
  CONFIG = 'config',
  UI = 'ui',
  SYSTEM = 'system'
}

export interface LogEntry {
  timestamp: string
  level: LogLevel
  category: string
  message: string
  data?: Record<string, unknown>
}

/**
 * Format options for consistent output.
 */
interface FormatOptions {
  /** Include timestamp in output */
  timestamp?: boolean
  /** Include data object in output */
  includeData?: boolean
  /** Max length for data JSON (truncate if longer) */
  maxDataLength?: number
}

const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  timestamp: true,
  includeData: true,
  maxDataLength: 500
}

/**
 * Format a log entry for console/file output.
 */
function formatLogEntry(entry: LogEntry, options: FormatOptions = DEFAULT_FORMAT_OPTIONS): string {
  const parts: string[] = []

  // Timestamp (HH:MM:SS.mmm format for readability)
  if (options.timestamp) {
    const date = new Date(entry.timestamp)
    const time = date.toTimeString().split(' ')[0]
    const ms = String(date.getMilliseconds()).padStart(3, '0')
    parts.push(`${time}.${ms}`)
  }

  // Level with fixed width and color hints
  const levelStr = entry.level.toUpperCase().padEnd(5)
  parts.push(`[${levelStr}]`)

  // Category with fixed width
  const categoryStr = entry.category.padEnd(10)
  parts.push(`[${categoryStr}]`)

  // Message
  parts.push(entry.message)

  // Data (if present and enabled)
  if (options.includeData && entry.data && Object.keys(entry.data).length > 0) {
    let dataStr = JSON.stringify(entry.data)
    if (options.maxDataLength && dataStr.length > options.maxDataLength) {
      dataStr = dataStr.substring(0, options.maxDataLength) + '...'
    }
    parts.push(dataStr)
  }

  return parts.join(' ')
}

/**
 * Get console styling for log level (for browser dev tools).
 */
function getConsoleStyle(level: LogLevel): string {
  switch (level) {
    case LogLevel.ERROR:
      return 'color: #dc2626; font-weight: bold'
    case LogLevel.WARN:
      return 'color: #d97706; font-weight: bold'
    case LogLevel.INFO:
      return 'color: #2563eb'
    case LogLevel.DEBUG:
      return 'color: #6b7280'
    default:
      return ''
  }
}

class Logger {
  private entries: LogEntry[] = []
  private maxEntries = 1000
  private minLevel: LogLevel = LogLevel.DEBUG

  /**
   * Set minimum log level (logs below this level are ignored).
   */
  setMinLevel(level: LogLevel) {
    this.minLevel = level
  }

  /**
   * Check if a level should be logged based on minLevel.
   */
  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR]
    return levels.indexOf(level) >= levels.indexOf(this.minLevel)
  }

  /**
   * Core logging method.
   */
  log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>) {
    if (!this.shouldLog(level)) return

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data
    }

    this.entries.push(entry)

    // Circular buffer
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }

    // Console output: errors/warnings always, debug/info only in dev
    const isImportant = level === LogLevel.ERROR || level === LogLevel.WARN
    if (isImportant || import.meta.env.DEV) {
      const formatted = formatLogEntry(entry, { timestamp: true, includeData: false })
      const style = getConsoleStyle(level)

      /* eslint-disable no-console */
      const consoleFn = level === LogLevel.ERROR ? console.error :
                        level === LogLevel.WARN ? console.warn :
                        level === LogLevel.DEBUG ? console.debug :
                        console.log
      /* eslint-enable no-console */

      if (data && Object.keys(data).length > 0) {
        consoleFn(`%c${formatted}`, style, data)
      } else {
        consoleFn(`%c${formatted}`, style)
      }
    }
  }

  // Convenience methods with category
  debug(category: string, message: string, data?: Record<string, unknown>) {
    this.log(LogLevel.DEBUG, category, message, data)
  }

  info(category: string, message: string, data?: Record<string, unknown>) {
    this.log(LogLevel.INFO, category, message, data)
  }

  warn(category: string, message: string, data?: Record<string, unknown>) {
    this.log(LogLevel.WARN, category, message, data)
  }

  error(category: string, message: string, data?: Record<string, unknown>) {
    this.log(LogLevel.ERROR, category, message, data)
  }

  // Category-specific loggers for common use cases
  import = {
    debug: (msg: string, data?: Record<string, unknown>) => this.debug(LogCategory.IMPORT, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => this.info(LogCategory.IMPORT, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => this.warn(LogCategory.IMPORT, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => this.error(LogCategory.IMPORT, msg, data)
  }

  api = {
    debug: (msg: string, data?: Record<string, unknown>) => this.debug(LogCategory.API, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => this.info(LogCategory.API, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => this.warn(LogCategory.API, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => this.error(LogCategory.API, msg, data)
  }

  csv = {
    debug: (msg: string, data?: Record<string, unknown>) => this.debug(LogCategory.CSV, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => this.info(LogCategory.CSV, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => this.warn(LogCategory.CSV, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => this.error(LogCategory.CSV, msg, data)
  }

  worker = {
    debug: (msg: string, data?: Record<string, unknown>) => this.debug(LogCategory.WORKER, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => this.info(LogCategory.WORKER, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => this.warn(LogCategory.WORKER, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => this.error(LogCategory.WORKER, msg, data)
  }

  validation = {
    debug: (msg: string, data?: Record<string, unknown>) => this.debug(LogCategory.VALIDATION, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => this.info(LogCategory.VALIDATION, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => this.warn(LogCategory.VALIDATION, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => this.error(LogCategory.VALIDATION, msg, data)
  }

  profile = {
    debug: (msg: string, data?: Record<string, unknown>) => this.debug(LogCategory.PROFILE, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => this.info(LogCategory.PROFILE, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => this.warn(LogCategory.PROFILE, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => this.error(LogCategory.PROFILE, msg, data)
  }

  /**
   * Get all log entries, optionally filtered.
   */
  getEntries(filter?: { level?: LogLevel; category?: string }): LogEntry[] {
    let result = [...this.entries]

    if (filter?.level) {
      result = result.filter(e => e.level === filter.level)
    }
    if (filter?.category) {
      result = result.filter(e => e.category === filter.category)
    }

    return result
  }

  /**
   * Export all logs as formatted string.
   */
  export(): string {
    return this.entries
      .map(e => formatLogEntry(e, { timestamp: true, includeData: true, maxDataLength: 1000 }))
      .join('\n')
  }

  /**
   * Export logs as JSON for debugging.
   */
  exportJSON(): string {
    return JSON.stringify(this.entries, null, 2)
  }

  /**
   * Clear all log entries.
   */
  clear() {
    this.entries = []
  }

  /**
   * Get count of entries by level.
   */
  getCounts(): Record<LogLevel, number> {
    return {
      [LogLevel.DEBUG]: this.entries.filter(e => e.level === LogLevel.DEBUG).length,
      [LogLevel.INFO]: this.entries.filter(e => e.level === LogLevel.INFO).length,
      [LogLevel.WARN]: this.entries.filter(e => e.level === LogLevel.WARN).length,
      [LogLevel.ERROR]: this.entries.filter(e => e.level === LogLevel.ERROR).length
    }
  }
}

export const logger = new Logger()
