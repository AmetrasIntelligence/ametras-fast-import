import { describe, it, expect } from 'vitest'
import { decideStartupWatchdog } from '@/utils/startupWatchdog'

const base = {
  hasProgress: false,
  running: true,
  offline: false,
  engineAliveSinceArm: false,
}

describe('decideStartupWatchdog', () => {
  it('cancels a running import that sent nothing since the watchdog was armed', () => {
    expect(decideStartupWatchdog(base)).toBe('cancel')
  })

  it('re-arms while the engine sends heartbeats although no batch is done yet', () => {
    // A first batch of slow creates can take minutes; heartbeats show rows
    // still finish, so the run must not be cancelled.
    expect(decideStartupWatchdog({ ...base, engineAliveSinceArm: true })).toBe('rearm')
  })

  it('re-arms while the connection is offline', () => {
    expect(decideStartupWatchdog({ ...base, offline: true })).toBe('rearm')
  })

  it('stops once a batch has reported progress', () => {
    expect(decideStartupWatchdog({ ...base, hasProgress: true })).toBe('stop')
  })

  it('stops when the import is no longer running a file', () => {
    expect(decideStartupWatchdog({ ...base, running: false })).toBe('stop')
  })
})
