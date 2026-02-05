import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockApi } from '../setup'
import {
  DEMO_CSV_PARTNER_SIMPLE,
  DEMO_CSV_SPECIAL_CHARS,
  DEMO_CSV_BANK,
  generateLargeCSV
} from '../fixtures'

// Import after mocks are set up
import { parseCSV, analyzeCSV } from '@/importer/csvParser'

describe('csvParser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('parseCSV', () => {
    it('parses simple CSV correctly', async () => {
      mockApi.files.read.mockResolvedValue(DEMO_CSV_PARTNER_SIMPLE)

      const rows = await parseCSV('test-file-id')

      expect(rows).toHaveLength(3)
      expect(rows[0].index).toBe(1)
      expect(rows[0].data.id).toBe('partner_1')
      expect(rows[0].data.name).toBe('Test Company')
      expect(rows[0].data.email).toBe('test@example.com')
    })

    it('parses CSV with special characters', async () => {
      mockApi.files.read.mockResolvedValue(DEMO_CSV_SPECIAL_CHARS)

      const rows = await parseCSV('test-file-id')

      expect(rows).toHaveLength(3)
      expect(rows[0].data.name).toBe('Company, Inc.')
      expect(rows[0].data.description).toBe('Line1\nLine2')
      expect(rows[1].data.name).toBe('Quote "Test"')
      expect(rows[2].data.name).toBe('Unicode äöü')
    })

    it('trims header names', async () => {
      const csvWithSpaces = `  id  ,  name  , email
1,Test,test@test.com`
      mockApi.files.read.mockResolvedValue(csvWithSpaces)

      const rows = await parseCSV('test-file-id')

      expect(rows[0].data).toHaveProperty('id')
      expect(rows[0].data).toHaveProperty('name')
      expect(rows[0].data).toHaveProperty('email')
    })

    it('skips empty lines', async () => {
      const csvWithEmptyLines = `id,name
1,First

2,Second

3,Third`
      mockApi.files.read.mockResolvedValue(csvWithEmptyLines)

      const rows = await parseCSV('test-file-id')

      expect(rows).toHaveLength(3)
    })

    it('returns raw values array', async () => {
      mockApi.files.read.mockResolvedValue(DEMO_CSV_PARTNER_SIMPLE)

      const rows = await parseCSV('test-file-id')

      expect(rows[0].raw).toEqual(['partner_1', 'Test Company', 'test@example.com', '+49123456', 'true'])
    })

    it('handles custom delimiter', async () => {
      const semicolonCSV = `id;name;email
1;Test;test@test.com`
      mockApi.files.read.mockResolvedValue(semicolonCSV)

      const rows = await parseCSV('test-file-id', { delimiter: ';' })

      expect(rows[0].data.id).toBe('1')
      expect(rows[0].data.name).toBe('Test')
    })

    it('handles CSV without header when specified', async () => {
      const noHeaderCSV = `1,Test,test@test.com
2,Another,another@test.com`
      mockApi.files.read.mockResolvedValue(noHeaderCSV)

      const rows = await parseCSV('test-file-id', { hasHeader: false })

      // Without header, data keys are column indices
      expect(rows).toHaveLength(2)
    })
  })

  describe('analyzeCSV', () => {
    it('detects headers correctly', async () => {
      mockApi.files.readHead.mockResolvedValue(DEMO_CSV_BANK)
      mockApi.files.countLines.mockResolvedValue(6)

      const analysis = await analyzeCSV('test-file-id')

      expect(analysis.headers).toEqual(['id', 'name', 'bic'])
      expect(analysis.rowCount).toBe(5) // 6 lines - 1 header
    })

    it('detects id column', async () => {
      mockApi.files.readHead.mockResolvedValue(DEMO_CSV_PARTNER_SIMPLE)
      mockApi.files.countLines.mockResolvedValue(4)

      const analysis = await analyzeCSV('test-file-id')

      expect(analysis.hasIdColumn).toBe(true)
      expect(analysis.hasDotIdColumn).toBe(false)
    })

    it('detects .id column', async () => {
      const csvWithDotId = `.id,name,value
1,Test,100`
      mockApi.files.readHead.mockResolvedValue(csvWithDotId)
      mockApi.files.countLines.mockResolvedValue(2)

      const analysis = await analyzeCSV('test-file-id')

      expect(analysis.hasIdColumn).toBe(false)
      expect(analysis.hasDotIdColumn).toBe(true)
    })

    it('provides sample rows', async () => {
      mockApi.files.readHead.mockResolvedValue(DEMO_CSV_PARTNER_SIMPLE)
      mockApi.files.countLines.mockResolvedValue(4)

      const analysis = await analyzeCSV('test-file-id')

      expect(analysis.sampleRows.length).toBeGreaterThan(0)
      expect(analysis.sampleRows[0]).toHaveProperty('id')
      expect(analysis.sampleRows[0]).toHaveProperty('name')
    })

    it('detects delimiter', async () => {
      mockApi.files.readHead.mockResolvedValue(DEMO_CSV_BANK)
      mockApi.files.countLines.mockResolvedValue(6)

      const analysis = await analyzeCSV('test-file-id')

      expect(analysis.delimiter).toBe(',')
    })

    it('handles semicolon delimiter', async () => {
      const semicolonCSV = `id;name;value
1;Test;100`
      mockApi.files.readHead.mockResolvedValue(semicolonCSV)
      mockApi.files.countLines.mockResolvedValue(2)

      const analysis = await analyzeCSV('test-file-id')

      expect(analysis.delimiter).toBe(';')
    })

    it('reads only first 10KB for analysis', async () => {
      mockApi.files.readHead.mockResolvedValue(DEMO_CSV_BANK)
      mockApi.files.countLines.mockResolvedValue(1000)

      await analyzeCSV('test-file-id')

      expect(mockApi.files.readHead).toHaveBeenCalledWith('test-file-id', 10240)
    })
  })
})
