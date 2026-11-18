/**
 * Decision of the startup watchdog in standalone mode.
 *
 * The watchdog cancels an import that shows no sign of life after it starts.
 * A batch reports progress only when it is done, and on a slow server the
 * first batch can take minutes; the Python engine therefore sends heartbeats
 * while rows finish. A heartbeat since the watchdog was armed re-arms it, so
 * only an engine that is silent for a whole period is cancelled.
 */
export type StartupWatchdogAction = 'stop' | 'rearm' | 'cancel'

export interface StartupWatchdogInput {
  /** A batch has reported processed rows. */
  hasProgress: boolean
  /** The import is still running a file. */
  running: boolean
  /** The connection to the server is lost; the engine may be reconnecting. */
  offline: boolean
  /** The engine sent a heartbeat since the watchdog was last armed. */
  engineAliveSinceArm: boolean
}

export function decideStartupWatchdog(input: StartupWatchdogInput): StartupWatchdogAction {
  if (input.hasProgress || !input.running) return 'stop'
  if (input.offline || input.engineAliveSinceArm) return 'rearm'
  return 'cancel'
}
