/** Import state — mirrors the server's job_state. */
export enum ImportState {
  IDLE = 'idle',
  VALIDATING = 'validating',
  RUNNING_FILE = 'running',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
  INTERRUPTED = 'interrupted',
}

/** Connection status for display. */
export type ConnectionStatus = 'online' | 'offline' | 'checking'
