import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockApi } from '../setup'
import { useSessionStore } from '@/stores/session'
import {
  createImportLog,
  updateImportLog,
  finalizeImportLog,
  getImportLog,
  saveImportLog,
} from '@/api/odooClient'

describe('odooClient log functions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setEmbeddedMode() {
    const session = useSessionStore()
    session.setEmbeddedMode({
      uid: 1,
      baseUrl: 'http://localhost:8069',
      db: 'test_db',
    })
  }

  describe('createImportLog', () => {
    it('returns null if not in embedded mode', async () => {
      // Default session is not embedded
      const result = await createImportLog({
        profile_name: 'Test',
        is_dry_run: false,
        started_at: '2026-03-02T12:00:00Z',
        filenames: ['test.csv'],
        total_rows: 100,
      })
      expect(result).toBeNull()
      expect(mockApi.odoo.call).not.toHaveBeenCalled()
    })

    it('calls the create endpoint in embedded mode', async () => {
      setEmbeddedMode()
      mockApi.odoo.call.mockResolvedValue({
        ok: true,
        result: { ok: true, id: 42 },
      })

      const result = await createImportLog({
        profile_name: 'Test Profile',
        is_dry_run: false,
        started_at: '2026-03-02T12:00:00Z',
        filenames: ['contacts.csv', 'products.csv'],
        total_rows: 500,
        profile_id: 7,
        attachment_ids: [1, 2],
      })

      expect(result).toBe(42)
      expect(mockApi.odoo.call).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/ametras_fast_import/log/create',
          params: expect.objectContaining({
            profile_name: 'Test Profile',
            is_dry_run: false,
            filenames: ['contacts.csv', 'products.csv'],
            total_rows: 500,
            profile_id: 7,
            attachment_ids: [1, 2],
          }),
        })
      )
    })

    it('returns null when the server response is not ok', async () => {
      setEmbeddedMode()
      mockApi.odoo.call.mockResolvedValue({
        ok: false,
        error: 'Internal error',
      })

      const result = await createImportLog({
        profile_name: 'Test',
        is_dry_run: false,
        started_at: '2026-03-02T12:00:00Z',
        filenames: [],
        total_rows: 0,
      })

      expect(result).toBeNull()
    })
  })

  describe('updateImportLog', () => {
    it('skips if not in embedded mode', async () => {
      await updateImportLog({
        log_id: 1,
        success_rows: 50,
        failed_rows: 2,
        file_progress: {},
      })
      expect(mockApi.odoo.call).not.toHaveBeenCalled()
    })

    it('calls the update endpoint in embedded mode', async () => {
      setEmbeddedMode()
      mockApi.odoo.call.mockResolvedValue({ ok: true })

      await updateImportLog({
        log_id: 42,
        success_rows: 100,
        failed_rows: 5,
        file_progress: {
          'contacts.csv': {
            totalRows: 200,
            successCount: 100,
            failedCount: 5,
            processedRanges: [[1, 105]],
          },
        },
      })

      expect(mockApi.odoo.call).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/ametras_fast_import/log/update',
          params: expect.objectContaining({
            log_id: 42,
            success_rows: 100,
            failed_rows: 5,
          }),
        })
      )
    })
  })

  describe('finalizeImportLog', () => {
    it('skips if not in embedded mode', async () => {
      await finalizeImportLog({
        log_id: 1,
        state: 'completed',
        finished_at: '2026-03-02T12:30:00Z',
        success_rows: 100,
        failed_rows: 0,
        error_log: [],
      })
      expect(mockApi.odoo.call).not.toHaveBeenCalled()
    })

    it('calls the finalize endpoint in embedded mode', async () => {
      setEmbeddedMode()
      mockApi.odoo.call.mockResolvedValue({ ok: true })

      await finalizeImportLog({
        log_id: 42,
        state: 'failed',
        finished_at: '2026-03-02T12:30:00Z',
        total_rows: 200,
        success_rows: 195,
        failed_rows: 5,
        error_log: [
          { filename: 'test.csv', rowNumber: 10, error: 'Invalid value' },
        ],
      })

      expect(mockApi.odoo.call).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/ametras_fast_import/log/finalize',
          params: expect.objectContaining({
            log_id: 42,
            state: 'failed',
            success_rows: 195,
            failed_rows: 5,
          }),
        })
      )
    })
  })

  describe('getImportLog', () => {
    it('returns null if not in embedded mode', async () => {
      const result = await getImportLog(42)
      expect(result).toBeNull()
      expect(mockApi.odoo.call).not.toHaveBeenCalled()
    })

    it('returns log record on success', async () => {
      setEmbeddedMode()

      const mockLog = {
        id: 42,
        profile_name: 'Test Profile',
        profile_id: 7,
        user_id: 1,
        is_dry_run: false,
        state: 'interrupted',
        started_at: '2026-03-02T12:00:00',
        finished_at: null,
        duration_seconds: 300,
        filenames: ['contacts.csv'],
        total_rows: 1000,
        success_rows: 500,
        failed_rows: 10,
        pending_rows: 490,
        file_progress: {
          'contacts.csv': {
            totalRows: 1000,
            successCount: 500,
            failedCount: 10,
            processedRanges: [[1, 510]],
          },
        },
        error_log: [{ filename: 'contacts.csv', rowNumber: 42, error: 'Invalid email' }],
        attachment_ids: [100, 101],
      }

      mockApi.odoo.call.mockResolvedValue({
        ok: true,
        result: { ok: true, log: mockLog },
      })

      const result = await getImportLog(42)
      expect(result).toEqual(mockLog)
      expect(mockApi.odoo.call).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/ametras_fast_import/log/get',
          params: { log_id: 42 },
        })
      )
    })

    it('returns null when server response is not ok', async () => {
      setEmbeddedMode()
      mockApi.odoo.call.mockResolvedValue({
        ok: false,
        error: 'Log not found',
      })

      const result = await getImportLog(999)
      expect(result).toBeNull()
    })
  })

  describe('saveImportLog (legacy)', () => {
    it('skips if not in embedded mode', async () => {
      await saveImportLog({
        profile_name: 'Test',
        is_dry_run: false,
        state: 'completed',
        started_at: '2026-03-02T12:00:00Z',
        finished_at: '2026-03-02T12:30:00Z',
        filenames: ['test.csv'],
        total_rows: 100,
        success_rows: 100,
        failed_rows: 0,
        error_log: [],
      })
      expect(mockApi.odoo.call).not.toHaveBeenCalled()
    })

    it('calls the save endpoint in embedded mode', async () => {
      setEmbeddedMode()
      mockApi.odoo.call.mockResolvedValue({ ok: true })

      await saveImportLog({
        profile_name: 'Test',
        is_dry_run: true,
        state: 'completed',
        started_at: '2026-03-02T12:00:00Z',
        finished_at: '2026-03-02T12:30:00Z',
        filenames: ['test.csv'],
        total_rows: 100,
        success_rows: 98,
        failed_rows: 2,
        error_log: [
          { filename: 'test.csv', rowNumber: 5, error: 'Bad value' },
        ],
      })

      expect(mockApi.odoo.call).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/ametras_fast_import/log/save',
        })
      )
    })
  })
})
