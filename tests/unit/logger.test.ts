import { describe, it, expect, beforeEach, vi } from 'vitest'
import { logger, LogLevel } from '@/utils/logger'

describe('Logger', () => {
  beforeEach(() => {
    logger.clear()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  describe('log levels', () => {
    it('logs debug messages', () => {
      logger.debug('TestCategory', 'Debug message')

      const entries = logger.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0].level).toBe(LogLevel.DEBUG)
      expect(entries[0].category).toBe('TestCategory')
      expect(entries[0].message).toBe('Debug message')
    })

    it('logs info messages', () => {
      logger.info('TestCategory', 'Info message')

      const entries = logger.getEntries()
      expect(entries[0].level).toBe(LogLevel.INFO)
    })

    it('logs warn messages', () => {
      logger.warn('TestCategory', 'Warning message')

      const entries = logger.getEntries()
      expect(entries[0].level).toBe(LogLevel.WARN)
    })

    it('logs error messages', () => {
      logger.error('TestCategory', 'Error message')

      const entries = logger.getEntries()
      expect(entries[0].level).toBe(LogLevel.ERROR)
    })
  })

  describe('data attachment', () => {
    it('attaches data to log entry', () => {
      logger.info('Test', 'Message with data', { userId: 123, action: 'import' })

      const entries = logger.getEntries()
      expect(entries[0].data).toEqual({ userId: 123, action: 'import' })
    })

    it('handles missing data', () => {
      logger.info('Test', 'Message without data')

      const entries = logger.getEntries()
      expect(entries[0].data).toBeUndefined()
    })
  })

  describe('filtering', () => {
    beforeEach(() => {
      logger.debug('Cat1', 'Debug 1')
      logger.info('Cat1', 'Info 1')
      logger.warn('Cat2', 'Warn 1')
      logger.error('Cat2', 'Error 1')
    })

    it('filters by level', () => {
      const errors = logger.getEntries({ level: LogLevel.ERROR })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toBe('Error 1')
    })

    it('filters by category', () => {
      const cat1 = logger.getEntries({ category: 'Cat1' })
      expect(cat1).toHaveLength(2)
    })

    it('filters by both level and category', () => {
      const filtered = logger.getEntries({ level: LogLevel.WARN, category: 'Cat2' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].message).toBe('Warn 1')
    })
  })

  describe('ring buffer', () => {
    it('limits entries to maxEntries', () => {
      // Log more than maxEntries (1000)
      for (let i = 0; i < 1100; i++) {
        logger.info('Test', `Message ${i}`)
      }

      const entries = logger.getEntries()
      expect(entries.length).toBeLessThanOrEqual(1000)
    })

    it('keeps most recent entries', () => {
      for (let i = 0; i < 1100; i++) {
        logger.info('Test', `Message ${i}`)
      }

      const entries = logger.getEntries()
      const lastEntry = entries[entries.length - 1]
      expect(lastEntry.message).toBe('Message 1099')
    })
  })

  describe('export', () => {
    it('exports log as formatted string', () => {
      logger.info('Import', 'Starting import', { files: 3 })
      logger.error('Import', 'Failed to connect')

      const exported = logger.export()

      expect(exported).toContain('[INFO]')
      expect(exported).toContain('[Import]')
      expect(exported).toContain('Starting import')
      expect(exported).toContain('[ERROR]')
      expect(exported).toContain('Failed to connect')
    })

    it('includes data in export', () => {
      logger.info('Test', 'Message', { key: 'value' })

      const exported = logger.export()
      expect(exported).toContain('"key":"value"')
    })
  })

  describe('clear', () => {
    it('removes all entries', () => {
      logger.info('Test', 'Message 1')
      logger.info('Test', 'Message 2')

      logger.clear()

      expect(logger.getEntries()).toHaveLength(0)
    })
  })

  describe('timestamp', () => {
    it('includes ISO timestamp', () => {
      logger.info('Test', 'Message')

      const entries = logger.getEntries()
      expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })
})
