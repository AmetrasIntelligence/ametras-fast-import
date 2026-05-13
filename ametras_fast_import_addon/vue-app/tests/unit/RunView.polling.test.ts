/**
 * Integration tests for RunView polling pipeline.
 *
 * P3.1: Drive the full happy-path → polling → completion loop, the stall
 * detection scenario, and the poll-failure / connection-recovery scenario
 * using a mocked window.api.odoo.call.
 *
 * RunView's pollProgress() function is a local closure, so we replicate the
 * same logic here: call window.api.odoo.call, feed the result into
 * run.updateFromServer, and inspect the resulting store state.  This matches
 * the established codebase pattern (RunView.abort / RunView.control tests).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useRunStore } from '@/stores/run'
import { ImportState } from '@/types/importState'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: vi.fn(),
}))

// ── helpers ──────────────────────────────────────────────────────────────

const mockOdooCall = vi.fn()
Object.defineProperty(window, 'api', {
  value: { odoo: { call: mockOdooCall } },
  writable: true,
})

function progressResponse(
  state: string,
  files: Record<string, { totalRows: number; successCount: number; failedCount: number }>,
  opts: { heartbeat?: string | null; errors?: Array<{ filename: string; rowNumber: number; error: string }> } = {}
) {
  return {
    ok: true,
    result: {
      state,
      progress: files,
      success_rows: Object.values(files).reduce((s, f) => s + f.successCount, 0),
      failed_rows: Object.values(files).reduce((s, f) => s + f.failedCount, 0),
      total_rows: Object.values(files).reduce((s, f) => s + f.totalRows, 0),
      current_file: Object.keys(files)[0] ?? '',
      errors: opts.errors ?? [],
      is_dry_run: false,
      heartbeat: opts.heartbeat !== undefined ? opts.heartbeat : new Date().toISOString(),
    },
  }
}

/**
 * Simulate one pollProgress tick: call the API, feed result into the store,
 * mirror the consecutive-failure tracking RunView uses.
 */
async function tick(
  run: ReturnType<typeof useRunStore>,
  logId: number,
  state: { consecutiveFailures: number }
) {
  const resp = await window.api.odoo.call({
    baseUrl: '',
    endpoint: '/ametras_fast_import/import/progress',
    params: { log_id: logId },
  })

  if (resp.ok && resp.result) {
    run.updateFromServer(resp.result)
    if (state.consecutiveFailures > 0) {
      state.consecutiveFailures = 0
      run.connectionStatus = 'online'
    }
  } else {
    state.consecutiveFailures++
    run.connectionStatus = 'offline'
  }
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('RunView polling — happy path', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockOdooCall.mockReset()
  })

  it('progresses from RUNNING_FILE to COMPLETED across multiple polls', async () => {
    const run = useRunStore()
    run.initRun(['data.csv'], new Map([['data.csv', 100]]))
    run.setState(ImportState.RUNNING_FILE)
    run.logId = 1

    const state = { consecutiveFailures: 0 }

    // Poll 1: 50% through
    mockOdooCall.mockResolvedValueOnce(
      progressResponse('running', { 'data.csv': { totalRows: 100, successCount: 50, failedCount: 0 } })
    )
    await tick(run, 1, state)
    expect(run.state).toBe(ImportState.RUNNING_FILE)
    expect(run.progress.files['data.csv'].processedRows).toBe(50)

    // Poll 2: done
    mockOdooCall.mockResolvedValueOnce(
      progressResponse('completed', { 'data.csv': { totalRows: 100, successCount: 100, failedCount: 0 } })
    )
    await tick(run, 1, state)
    expect(run.state).toBe(ImportState.COMPLETED)
    expect(run.progress.files['data.csv'].successCount).toBe(100)
    expect(state.consecutiveFailures).toBe(0)
    expect(run.connectionStatus).toBe('online')
  })

  it('records errors from poll responses without duplicates', async () => {
    const run = useRunStore()
    run.initRun(['f.csv'], new Map([['f.csv', 10]]))
    run.setState(ImportState.RUNNING_FILE)
    run.logId = 2

    const state = { consecutiveFailures: 0 }
    const error1 = { filename: 'f.csv', rowNumber: 3, error: 'Invalid email' }

    // Same error twice — deduplication must keep only one copy
    mockOdooCall.mockResolvedValue(
      progressResponse('running', { 'f.csv': { totalRows: 10, successCount: 5, failedCount: 1 } }, { errors: [error1] })
    )
    await tick(run, 2, state)
    await tick(run, 2, state)

    expect(run.errors.length).toBe(1)
    expect(run.errors[0].rowNumber).toBe(3)
  })

  it('multi-file: completedFiles tracks finished files correctly', async () => {
    const run = useRunStore()
    run.initRun(['a.csv', 'b.csv'], new Map([['a.csv', 10], ['b.csv', 20]]))
    run.setState(ImportState.RUNNING_FILE)
    run.logId = 3

    const state = { consecutiveFailures: 0 }

    // a.csv done, b.csv half done
    mockOdooCall.mockResolvedValueOnce(
      progressResponse('running', {
        'a.csv': { totalRows: 10, successCount: 10, failedCount: 0 },
        'b.csv': { totalRows: 20, successCount: 10, failedCount: 0 },
      })
    )
    await tick(run, 3, state)
    expect(run.progress.completedFiles).toBe(1)

    // Both done
    mockOdooCall.mockResolvedValueOnce(
      progressResponse('completed', {
        'a.csv': { totalRows: 10, successCount: 10, failedCount: 0 },
        'b.csv': { totalRows: 20, successCount: 20, failedCount: 0 },
      })
    )
    await tick(run, 3, state)
    expect(run.progress.completedFiles).toBe(2)
    expect(run.state).toBe(ImportState.COMPLETED)
  })
})

describe('RunView polling — stall detection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockOdooCall.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('isStalled is false immediately after a fresh heartbeat', async () => {
    const run = useRunStore()
    run.initRun(['big.csv'], new Map([['big.csv', 5000]]))
    run.setState(ImportState.RUNNING_FILE)
    run.logId = 4

    const freshHb = new Date().toISOString()
    mockOdooCall.mockResolvedValueOnce(
      progressResponse('running', { 'big.csv': { totalRows: 5000, successCount: 100, failedCount: 0 } }, { heartbeat: freshHb })
    )
    await tick(run, 4, { consecutiveFailures: 0 })
    expect(run.isStalled).toBe(false)
  })

  it('isStalled is true when server heartbeat is already 200 s old (> 90 s threshold)', async () => {
    const run = useRunStore()
    run.initRun(['big.csv'], new Map([['big.csv', 5000]]))
    run.setState(ImportState.RUNNING_FILE)
    run.logId = 5

    // Provide a heartbeat that is already 200 s in the past relative to the
    // frozen clock.  The computed isStalled sees age=200_000 > 90_000 → true.
    const staleHb = new Date(Date.now() - 200_000).toISOString()
    mockOdooCall.mockResolvedValueOnce(
      progressResponse('running', { 'big.csv': { totalRows: 5000, successCount: 0, failedCount: 0 } }, { heartbeat: staleHb })
    )
    await tick(run, 5, { consecutiveFailures: 0 })
    expect(run.isStalled).toBe(true)
  })

  it('isStalled is false when connectionStatus is offline (avoid false alarms)', async () => {
    const run = useRunStore()
    run.initRun(['big.csv'], new Map([['big.csv', 5000]]))
    run.setState(ImportState.RUNNING_FILE)
    run.logId = 6

    const staleHb = new Date(Date.now() - 200_000).toISOString()
    mockOdooCall.mockResolvedValueOnce(
      progressResponse('running', { 'big.csv': { totalRows: 5000, successCount: 0, failedCount: 0 } }, { heartbeat: staleHb })
    )
    await tick(run, 6, { consecutiveFailures: 0 })
    run.connectionStatus = 'offline'
    // Even though heartbeat is stale, offline state suppresses the stall banner
    expect(run.isStalled).toBe(false)
  })
})

describe('RunView polling — connection failure and recovery', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockOdooCall.mockReset()
  })

  it('connectionStatus goes offline on poll failure and recovers on success', async () => {
    const run = useRunStore()
    run.initRun(['x.csv'], new Map([['x.csv', 50]]))
    run.setState(ImportState.RUNNING_FILE)
    run.logId = 7

    const state = { consecutiveFailures: 0 }

    // First poll: network error
    mockOdooCall.mockResolvedValueOnce({ ok: false, error: 'Network timeout' })
    await tick(run, 7, state)
    expect(run.connectionStatus).toBe('offline')
    expect(state.consecutiveFailures).toBe(1)

    // Second poll: still down
    mockOdooCall.mockResolvedValueOnce({ ok: false, error: 'Network timeout' })
    await tick(run, 7, state)
    expect(run.connectionStatus).toBe('offline')
    expect(state.consecutiveFailures).toBe(2)

    // Third poll: recovered
    mockOdooCall.mockResolvedValueOnce(
      progressResponse('running', { 'x.csv': { totalRows: 50, successCount: 20, failedCount: 0 } })
    )
    await tick(run, 7, state)
    expect(run.connectionStatus).toBe('online')
    expect(state.consecutiveFailures).toBe(0)
    expect(run.state).toBe(ImportState.RUNNING_FILE)
  })

  it('state does not flip to IDLE when polls fail — import stays RUNNING_FILE', async () => {
    const run = useRunStore()
    run.initRun(['x.csv'], new Map([['x.csv', 50]]))
    run.setState(ImportState.RUNNING_FILE)
    run.logId = 8

    const state = { consecutiveFailures: 0 }
    mockOdooCall.mockResolvedValue({ ok: false, error: 'Connection refused' })

    for (let i = 0; i < 5; i++) {
      await tick(run, 8, state)
    }

    // State must stay RUNNING_FILE — not flip to IDLE or FAILED
    expect(run.state).toBe(ImportState.RUNNING_FILE)
    expect(state.consecutiveFailures).toBe(5)
  })

  it('skipped file is reflected in progress and completedFiles increments', async () => {
    const run = useRunStore()
    run.initRun(['skip.csv', 'keep.csv'], new Map([['skip.csv', 10], ['keep.csv', 10]]))
    run.setState(ImportState.RUNNING_FILE)
    run.logId = 9

    const state = { consecutiveFailures: 0 }
    mockOdooCall.mockResolvedValueOnce(
      progressResponse('running', {
        'skip.csv': { totalRows: 10, successCount: 0, failedCount: 0, skipped: true } as never,
        'keep.csv': { totalRows: 10, successCount: 5, failedCount: 0 },
      })
    )
    await tick(run, 9, state)
    // skip.csv has skipped=true → counted as completed
    expect(run.progress.completedFiles).toBeGreaterThanOrEqual(1)
    expect(run.progress.files['skip.csv'].skipped).toBe(true)
  })
})
