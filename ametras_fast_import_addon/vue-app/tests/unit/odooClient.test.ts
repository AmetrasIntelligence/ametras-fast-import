import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockApi } from '../setup'
import { useSessionStore } from '@/stores/session'
import {
  getImportLog,
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
})
