// standalone code flag (do not remove comment)
/**
 * Types for standalone import mode.
 */

export interface StandaloneBatchResult {
  ok: boolean
  rowIndex: number
  id?: number
  error?: string
  action?: 'created' | 'updated'
}

export interface StandaloneLoadResponse {
  ok: boolean
  ids?: number[]
  messages?: Array<{
    type: string
    message: string
    record?: number
    field?: string
  }>
  error?: string
}
