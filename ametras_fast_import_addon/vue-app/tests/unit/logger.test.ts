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
    it('logs all levels', () => {
      const methods: [keyof typeof logger, LogLevel][] = [
        ['debug', LogLevel.DEBUG],
        ['info', LogLevel.INFO],
        ['warn', LogLevel.WARN],
        ['error', LogLevel.ERROR],
      ]
      for (const [method, expectedLevel] of methods) {
        logger.clear()
        ;(logger[method] as (cat: string, msg: string) => void)('TestCategory', `${method} message`)
        const entries = logger.getEntries()
        expect(entries).toHaveLength(1)
        expect(entries[0].level).toBe(expectedLevel)
        expect(entries[0].category).toBe('TestCategory')
      }
    })
  })

  describe('data attachment', () => {
    it('attaches data when provided, undefined when not', () => {
      logger.info('Test', 'With data', { userId: 123, action: 'import' })
      logger.info('Test', 'Without data')

      const entries = logger.getEntries()
      expect(entries[0].data).toEqual({ userId: 123, action: 'import' })
      expect(entries[1].data).toBeUndefined()
    })
  })

  describe('filtering', () => {
    beforeEach(() => {
      logger.debug('Cat1', 'Debug 1')
      logger.info('Cat1', 'Info 1')
      logger.warn('Cat2', 'Warn 1')
      logger.error('Cat2', 'Error 1')
    })

    it('filters by level, category, and both', () => {
      expect(logger.getEntries({ level: LogLevel.ERROR })).toHaveLength(1)
      expect(logger.getEntries({ level: LogLevel.ERROR })[0].message).toBe('Error 1')
      expect(logger.getEntries({ category: 'Cat1' })).toHaveLength(2)

      const both = logger.getEntries({ level: LogLevel.WARN, category: 'Cat2' })
      expect(both).toHaveLength(1)
      expect(both[0].message).toBe('Warn 1')
    })
  })

  describe('ring buffer', () => {
    it('limits entries and keeps most recent', () => {
      for (let i = 0; i < 1100; i++) {
        logger.info('Test', `Message ${i}`)
      }

      const entries = logger.getEntries()
      expect(entries.length).toBeLessThanOrEqual(1000)
      expect(entries[entries.length - 1].message).toBe('Message 1099')
    })
  })

  describe('export', () => {
    it('exports log as formatted string with data', () => {
      logger.info('Import', 'Starting import', { files: 3 })
      logger.error('Import', 'Failed to connect')

      const exported = logger.export()
      expect(exported).toContain('[INFO ')
      expect(exported).toContain('[Import')
      expect(exported).toContain('Starting import')
      expect(exported).toContain('[ERROR]')
      expect(exported).toContain('Failed to connect')
    })

    it('includes data in export', () => {
      logger.info('Test', 'Message', { key: 'value' })
      expect(logger.export()).toContain('"key":"value"')
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
      expect(logger.getEntries()[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })
})
