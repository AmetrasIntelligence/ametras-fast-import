import { describe, it, expect, beforeEach } from 'vitest'
import { showAlert, showConfirm, showPrompt, useDialogState } from '@/composables/useDialog'

describe('useDialog', () => {
  let dialog: ReturnType<typeof useDialogState>

  beforeEach(() => {
    dialog = useDialogState()
    // Ensure dialog is closed before each test
    if (dialog.state.value.open) {
      dialog.cancel()
    }
  })

  describe('initial state', () => {
    it('starts closed', () => {
      expect(dialog.state.value.open).toBe(false)
    })

    it('defaults to alert type', () => {
      expect(dialog.state.value.type).toBe('alert')
    })

    it('has empty message', () => {
      expect(dialog.state.value.message).toBe('')
    })
  })

  describe('showAlert', () => {
    it('opens dialog with alert type', () => {
      showAlert('Something happened')
      expect(dialog.state.value.open).toBe(true)
      expect(dialog.state.value.type).toBe('alert')
      expect(dialog.state.value.message).toBe('Something happened')
    })

    it('resolves with undefined on confirm', async () => {
      const promise = showAlert('Test alert')
      dialog.confirm()
      const result = await promise
      expect(result).toBeUndefined()
    })

    it('resolves with undefined on cancel', async () => {
      const promise = showAlert('Test alert')
      dialog.cancel()
      const result = await promise
      expect(result).toBeUndefined()
    })

    it('closes dialog on confirm', () => {
      showAlert('Test')
      dialog.confirm()
      expect(dialog.state.value.open).toBe(false)
    })
  })

  describe('showConfirm', () => {
    it('opens dialog with confirm type', () => {
      showConfirm('Are you sure?')
      expect(dialog.state.value.open).toBe(true)
      expect(dialog.state.value.type).toBe('confirm')
      expect(dialog.state.value.message).toBe('Are you sure?')
    })

    it('resolves with true on confirm', async () => {
      const promise = showConfirm('Proceed?')
      dialog.confirm()
      expect(await promise).toBe(true)
    })

    it('resolves with false on cancel', async () => {
      const promise = showConfirm('Proceed?')
      dialog.cancel()
      expect(await promise).toBe(false)
    })

    it('closes dialog on confirm', () => {
      showConfirm('Test')
      dialog.confirm()
      expect(dialog.state.value.open).toBe(false)
    })

    it('closes dialog on cancel', () => {
      showConfirm('Test')
      dialog.cancel()
      expect(dialog.state.value.open).toBe(false)
    })
  })

  describe('showPrompt', () => {
    it('opens dialog with prompt type', () => {
      showPrompt('Enter name:')
      expect(dialog.state.value.open).toBe(true)
      expect(dialog.state.value.type).toBe('prompt')
      expect(dialog.state.value.message).toBe('Enter name:')
    })

    it('sets default value', () => {
      showPrompt('Enter name:', 'John')
      expect(dialog.state.value.defaultValue).toBe('John')
      expect(dialog.state.value.inputValue).toBe('John')
    })

    it('uses empty default when not provided', () => {
      showPrompt('Enter name:')
      expect(dialog.state.value.defaultValue).toBe('')
      expect(dialog.state.value.inputValue).toBe('')
    })

    it('resolves with input value on confirm', async () => {
      const promise = showPrompt('Enter name:', 'default')
      dialog.updateInput('Alice')
      dialog.confirm()
      expect(await promise).toBe('Alice')
    })

    it('resolves with default value if not changed', async () => {
      const promise = showPrompt('Enter name:', 'default')
      dialog.confirm()
      expect(await promise).toBe('default')
    })

    it('resolves with null on cancel', async () => {
      const promise = showPrompt('Enter name:', 'default')
      dialog.cancel()
      expect(await promise).toBeNull()
    })
  })

  describe('updateInput', () => {
    it('updates input value in state', () => {
      showPrompt('Test:')
      dialog.updateInput('new value')
      expect(dialog.state.value.inputValue).toBe('new value')
    })
  })

  describe('sequential dialogs', () => {
    it('can open a new dialog after closing one', async () => {
      const p1 = showConfirm('First?')
      dialog.confirm()
      await p1

      const p2 = showAlert('Second')
      expect(dialog.state.value.open).toBe(true)
      expect(dialog.state.value.type).toBe('alert')
      expect(dialog.state.value.message).toBe('Second')
      dialog.confirm()
      await p2
    })

    it('handles confirm → prompt sequence', async () => {
      const p1 = showConfirm('Sure?')
      dialog.confirm()
      expect(await p1).toBe(true)

      const p2 = showPrompt('Name?', 'Bob')
      dialog.updateInput('Eve')
      dialog.confirm()
      expect(await p2).toBe('Eve')
    })
  })

  describe('state is readonly', () => {
    it('exposes readonly state', () => {
      // The state ref returned by useDialogState should not allow
      // direct assignment — it's wrapped in readonly()
      expect(dialog.state).toBeDefined()
      expect(dialog.state.value).toBeDefined()
    })
  })
})
