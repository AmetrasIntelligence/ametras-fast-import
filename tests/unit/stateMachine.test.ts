import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ImportStateMachine, ImportState } from '@/importer/stateMachine'

describe('ImportStateMachine', () => {
  let sm: ImportStateMachine

  beforeEach(() => {
    sm = new ImportStateMachine()
  })

  describe('initial state', () => {
    it('starts in IDLE state', () => {
      expect(sm.state).toBe(ImportState.IDLE)
    })

    it('is not running initially', () => {
      expect(sm.isRunning).toBe(false)
    })

    it('cannot pause in IDLE state', () => {
      expect(sm.canPause).toBe(false)
    })
  })

  describe('valid transitions', () => {
    it('IDLE -> VALIDATING', () => {
      expect(sm.canTransition(ImportState.VALIDATING)).toBe(true)
      sm.transition(ImportState.VALIDATING)
      expect(sm.state).toBe(ImportState.VALIDATING)
    })

    it('VALIDATING -> RUNNING_FILE', () => {
      sm.transition(ImportState.VALIDATING)
      expect(sm.canTransition(ImportState.RUNNING_FILE)).toBe(true)
      sm.transition(ImportState.RUNNING_FILE)
      expect(sm.state).toBe(ImportState.RUNNING_FILE)
    })

    it('VALIDATING -> FAILED', () => {
      sm.transition(ImportState.VALIDATING)
      expect(sm.canTransition(ImportState.FAILED)).toBe(true)
      sm.transition(ImportState.FAILED)
      expect(sm.state).toBe(ImportState.FAILED)
    })

    it('RUNNING_FILE -> RUNNING_BATCH', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      expect(sm.canTransition(ImportState.RUNNING_BATCH)).toBe(true)
      sm.transition(ImportState.RUNNING_BATCH)
      expect(sm.state).toBe(ImportState.RUNNING_BATCH)
    })

    it('RUNNING_BATCH -> RETRYING', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.RUNNING_BATCH)
      expect(sm.canTransition(ImportState.RETRYING)).toBe(true)
      sm.transition(ImportState.RETRYING)
      expect(sm.state).toBe(ImportState.RETRYING)
    })

    it('RETRYING -> RUNNING_BATCH', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.RUNNING_BATCH)
      sm.transition(ImportState.RETRYING)
      expect(sm.canTransition(ImportState.RUNNING_BATCH)).toBe(true)
      sm.transition(ImportState.RUNNING_BATCH)
      expect(sm.state).toBe(ImportState.RUNNING_BATCH)
    })

    it('RUNNING_FILE -> COMPLETED', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      expect(sm.canTransition(ImportState.COMPLETED)).toBe(true)
      sm.transition(ImportState.COMPLETED)
      expect(sm.state).toBe(ImportState.COMPLETED)
    })

    it('RUNNING_FILE -> PAUSED', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      expect(sm.canTransition(ImportState.PAUSED)).toBe(true)
      sm.transition(ImportState.PAUSED)
      expect(sm.state).toBe(ImportState.PAUSED)
    })

    it('PAUSED -> RUNNING_FILE (resume)', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.PAUSED)
      expect(sm.canTransition(ImportState.RUNNING_FILE)).toBe(true)
      sm.transition(ImportState.RUNNING_FILE)
      expect(sm.state).toBe(ImportState.RUNNING_FILE)
    })

    it('PAUSED -> IDLE (cancel)', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.PAUSED)
      expect(sm.canTransition(ImportState.IDLE)).toBe(true)
      sm.transition(ImportState.IDLE)
      expect(sm.state).toBe(ImportState.IDLE)
    })
  })

  describe('invalid transitions', () => {
    it('IDLE -> RUNNING_FILE throws', () => {
      expect(sm.canTransition(ImportState.RUNNING_FILE)).toBe(false)
      expect(() => sm.transition(ImportState.RUNNING_FILE)).toThrow('Invalid transition')
    })

    it('IDLE -> COMPLETED throws', () => {
      expect(sm.canTransition(ImportState.COMPLETED)).toBe(false)
      expect(() => sm.transition(ImportState.COMPLETED)).toThrow('Invalid transition')
    })

    it('VALIDATING -> RETRYING throws', () => {
      sm.transition(ImportState.VALIDATING)
      expect(sm.canTransition(ImportState.RETRYING)).toBe(false)
      expect(() => sm.transition(ImportState.RETRYING)).toThrow('Invalid transition')
    })

    it('COMPLETED -> RUNNING_FILE throws', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.COMPLETED)
      expect(sm.canTransition(ImportState.RUNNING_FILE)).toBe(false)
      expect(() => sm.transition(ImportState.RUNNING_FILE)).toThrow('Invalid transition')
    })
  })

  describe('isRunning', () => {
    it('true in VALIDATING', () => {
      sm.transition(ImportState.VALIDATING)
      expect(sm.isRunning).toBe(true)
    })

    it('true in RUNNING_FILE', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      expect(sm.isRunning).toBe(true)
    })

    it('true in RUNNING_BATCH', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.RUNNING_BATCH)
      expect(sm.isRunning).toBe(true)
    })

    it('true in RETRYING', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.RUNNING_BATCH)
      sm.transition(ImportState.RETRYING)
      expect(sm.isRunning).toBe(true)
    })

    it('false in PAUSED', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.PAUSED)
      expect(sm.isRunning).toBe(false)
    })

    it('false in COMPLETED', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.COMPLETED)
      expect(sm.isRunning).toBe(false)
    })

    it('false in FAILED', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.FAILED)
      expect(sm.isRunning).toBe(false)
    })
  })

  describe('canPause', () => {
    it('true in RUNNING_FILE', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      expect(sm.canPause).toBe(true)
    })

    it('true in RUNNING_BATCH', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.RUNNING_BATCH)
      expect(sm.canPause).toBe(true)
    })

    it('false in RETRYING', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.RUNNING_BATCH)
      sm.transition(ImportState.RETRYING)
      expect(sm.canPause).toBe(false)
    })
  })

  describe('reset', () => {
    it('resets to IDLE from any state', () => {
      sm.transition(ImportState.VALIDATING)
      sm.transition(ImportState.RUNNING_FILE)
      sm.transition(ImportState.RUNNING_BATCH)
      sm.reset()
      expect(sm.state).toBe(ImportState.IDLE)
    })
  })

  describe('state change listeners', () => {
    it('notifies listeners on transition', () => {
      const listener = vi.fn()
      sm.onStateChange(listener)

      sm.transition(ImportState.VALIDATING)
      expect(listener).toHaveBeenCalledWith(ImportState.VALIDATING)
    })

    it('can unsubscribe listener', () => {
      const listener = vi.fn()
      const unsubscribe = sm.onStateChange(listener)

      sm.transition(ImportState.VALIDATING)
      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()
      sm.transition(ImportState.RUNNING_FILE)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('notifies on reset', () => {
      const listener = vi.fn()
      sm.onStateChange(listener)

      sm.transition(ImportState.VALIDATING)
      sm.reset()

      expect(listener).toHaveBeenLastCalledWith(ImportState.IDLE)
    })
  })
})
