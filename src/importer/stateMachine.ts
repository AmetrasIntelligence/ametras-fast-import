export enum ImportState {
  IDLE = 'IDLE',
  VALIDATING = 'VALIDATING',
  RUNNING_FILE = 'RUNNING_FILE',
  RUNNING_BATCH = 'RUNNING_BATCH',
  RETRYING = 'RETRYING',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED'
}

const VALID_TRANSITIONS: Record<ImportState, ImportState[]> = {
  [ImportState.IDLE]: [ImportState.VALIDATING],
  [ImportState.VALIDATING]: [ImportState.RUNNING_FILE, ImportState.FAILED],
  [ImportState.RUNNING_FILE]: [ImportState.RUNNING_BATCH, ImportState.COMPLETED, ImportState.FAILED, ImportState.PAUSED],
  [ImportState.RUNNING_BATCH]: [ImportState.RUNNING_FILE, ImportState.RETRYING, ImportState.COMPLETED, ImportState.FAILED, ImportState.PAUSED],
  [ImportState.RETRYING]: [ImportState.RUNNING_BATCH, ImportState.RUNNING_FILE, ImportState.COMPLETED, ImportState.FAILED],
  [ImportState.PAUSED]: [ImportState.RUNNING_FILE, ImportState.IDLE],
  [ImportState.COMPLETED]: [ImportState.IDLE],
  [ImportState.FAILED]: [ImportState.IDLE]
}

export class ImportStateMachine {
  private _state: ImportState = ImportState.IDLE
  private _listeners: Set<(state: ImportState) => void> = new Set()

  get state(): ImportState {
    return this._state
  }

  canTransition(to: ImportState): boolean {
    return VALID_TRANSITIONS[this._state].includes(to)
  }

  transition(to: ImportState): void {
    if (!this.canTransition(to)) {
      throw new Error(`Invalid transition: ${this._state} -> ${to}`)
    }
    this._state = to
    this._listeners.forEach(fn => fn(to))
  }

  tryTransition(to: ImportState): boolean {
    if (!this.canTransition(to)) {
      return false
    }
    this._state = to
    this._listeners.forEach(fn => fn(to))
    return true
  }

  reset(): void {
    this._state = ImportState.IDLE
    this._listeners.forEach(fn => fn(ImportState.IDLE))
  }

  onStateChange(fn: (state: ImportState) => void): () => void {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  get isRunning(): boolean {
    return [
      ImportState.VALIDATING,
      ImportState.RUNNING_FILE,
      ImportState.RUNNING_BATCH,
      ImportState.RETRYING
    ].includes(this._state)
  }

  get canPause(): boolean {
    return [ImportState.RUNNING_FILE, ImportState.RUNNING_BATCH].includes(this._state)
  }
}
