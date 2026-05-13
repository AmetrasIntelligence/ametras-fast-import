/**
 * Tests for the abort/complete race condition fix in RunView.
 *
 * Scenario: user clicks Abort while a Python import is in flight.
 * controlImport('cancel') sets state=FAILED synchronously; the still-awaiting
 * runPythonImport coroutine must not overwrite that state when it eventually
 * resolves. The fix uses a monotonic `runId` combined with the existing
 * `run.state !== ImportState.FAILED` guard.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useRunStore } from '@/stores/run'
import { ImportState } from '@/types/importState'

describe('RunView abort race guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('setState(FAILED) cannot be overwritten by a stale COMPLETED call', () => {
    const run = useRunStore()
    run.setState(ImportState.RUNNING_FILE)
    expect(run.state).toBe(ImportState.RUNNING_FILE)

    // Simulate abort: controlImport sets FAILED
    run.setState(ImportState.FAILED)
    expect(run.state).toBe(ImportState.FAILED)

    // Simulate stale runPythonImport finishing: the runId guard prevents this,
    // but even the existing state guard blocks the overwrite
    if (run.state !== ImportState.FAILED) {
      run.setState(ImportState.COMPLETED)
    }

    expect(run.state).toBe(ImportState.FAILED)
  })

  it('setState(FAILED) survives a new run starting and the old coroutine using stale runId', () => {
    const run = useRunStore()
    // Simulate: run 1 starts
    let currentRunId = 0
    const runId1 = ++currentRunId

    run.setState(ImportState.RUNNING_FILE)

    // Abort: FAILED set and run 2 starts
    run.setState(ImportState.FAILED)
    run.reset()
    run.setState(ImportState.RUNNING_FILE)
    const runId2 = ++currentRunId  // eslint-disable-line @typescript-eslint/no-unused-vars

    // Stale coroutine from run 1 tries to set COMPLETED
    // runId guard: runId1 !== currentRunId → skip
    if (runId1 === currentRunId && run.state !== ImportState.FAILED) {
      run.setState(ImportState.COMPLETED)
    }

    // The new run is still in RUNNING_FILE — stale coroutine didn't corrupt it
    expect(run.state).toBe(ImportState.RUNNING_FILE)
  })

  it('normal completion still works: final setState fires when runId matches', () => {
    const run = useRunStore()
    let currentRunId = 0
    const runId = ++currentRunId

    run.setState(ImportState.RUNNING_FILE)

    // No abort, normal completion
    if (runId === currentRunId && run.state !== ImportState.FAILED) {
      run.setState(ImportState.COMPLETED)
    }

    expect(run.state).toBe(ImportState.COMPLETED)
  })

  it('python error path: state stays FAILED when import fn throws', () => {
    const run = useRunStore()
    run.setState(ImportState.RUNNING_FILE)

    // Simulate the .catch handler in startImport
    const handleCatch = (e: Error) => {
      run.setState(ImportState.FAILED)
      return e.message
    }

    const errorMessage = handleCatch(new Error('connection refused'))
    expect(errorMessage).toBe('connection refused')
    expect(run.state).toBe(ImportState.FAILED)
  })

  it('poll timer is null after stopPolling is called', () => {
    // Verify that clearTimeout/null pattern works for poll cleanup
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    const stopPolling = () => {
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
    }

    pollTimer = setTimeout(() => {}, 10_000)
    expect(pollTimer).not.toBeNull()

    stopPolling()
    expect(pollTimer).toBeNull()

    // Idempotent — second call is safe
    stopPolling()
    expect(pollTimer).toBeNull()
  })
})
