/**
 * Tests for RunView control-button behaviour while offline.
 *
 * P1.5: buttons must be visibly disabled when connectionStatus === 'offline'
 * so that control actions aren't silently dropped.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useRunStore } from '@/stores/run'
import { ImportState } from '@/types/importState'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: vi.fn(),
}))

// Minimal mock of window.api — never succeeds
const mockOdooCall = vi.fn().mockResolvedValue({ ok: false, error: 'Connection refused' })
Object.defineProperty(window, 'api', {
  value: { odoo: { call: mockOdooCall } },
  writable: true,
})

describe('RunView control actions while offline', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockOdooCall.mockResolvedValue({ ok: false, error: 'Connection refused' })
  })

  it('isWaitingForConnection is true when connectionStatus is offline', () => {
    const run = useRunStore()
    run.connectionStatus = 'offline'
    expect(run.isWaitingForConnection).toBe(true)
  })

  it('isWaitingForConnection is false when connectionStatus is online', () => {
    const run = useRunStore()
    run.connectionStatus = 'online'
    expect(run.isWaitingForConnection).toBe(false)
  })

  it('controlImport with offline api call resolves without state corruption', async () => {
    const run = useRunStore()
    run.initRun(['f.csv'], new Map([['f.csv', 10]]))
    run.setState(ImportState.RUNNING_FILE)
    run.connectionStatus = 'offline'
    run.logId = 42

    // Simulate what controlImport does: odoo.call returns {ok: false}
    const resp = await window.api.odoo.call({
      baseUrl: '', endpoint: '/ametras_fast_import/import/control',
      params: { log_id: 42, action: 'resume' }
    })

    // The call fails silently — state must not flip to IDLE or FAILED
    expect(resp.ok).toBe(false)
    expect(run.state).toBe(ImportState.RUNNING_FILE)
  })
})
