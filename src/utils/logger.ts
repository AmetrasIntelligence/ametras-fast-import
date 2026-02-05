export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

export interface LogEntry {
  timestamp: string
  level: LogLevel
  category: string
  message: string
  data?: Record<string, unknown>
}

class Logger {
  private entries: LogEntry[] = []
  private maxEntries = 1000

  log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data
    }

    this.entries.push(entry)

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }

    if (import.meta.env.DEV) {
      const fn = level === 'error' ? console.error :
                 level === 'warn' ? console.warn :
                 console.log
      fn(`[${category}] ${message}`, data || '')
    }
  }

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

  export(): string {
    return this.entries
      .map(e => `${e.timestamp} [${e.level.toUpperCase()}] [${e.category}] ${e.message}${e.data ? ' ' + JSON.stringify(e.data) : ''}`)
      .join('\n')
  }

  clear() {
    this.entries = []
  }
}

export const logger = new Logger()
