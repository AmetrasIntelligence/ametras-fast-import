import { describe, it, expect, beforeEach } from 'vitest'
import { showAlert, showConfirm, showPrompt, useDialogState } from '@/utils/dialog'

describe('useDialog', () => {
  let dialog: ReturnType<typeof useDialogState>

  beforeEach(() => {
    dialog = useDialogState()
    if (dialog.state.value.open) {
      dialog.cancel()
    }
  })

  describe('initial state', () => {
    it('starts closed with defaults', () => {
      expect(dialog.state.value.open).toBe(false)
      expect(dialog.state.value.type).toBe('alert')
      expect(dialog.state.value.message).toBe('')
    })
  })

  describe('showAlert', () => {
    it('opens dialog and resolves on confirm/cancel', async () => {
      showAlert('Something happened')
      expect(dialog.state.value.open).toBe(true)
      expect(dialog.state.value.type).toBe('alert')
      expect(dialog.state.value.message).toBe('Something happened')
      dialog.cancel() // close to proceed

      const p1 = showAlert('Test alert')
      dialog.confirm()
      expect(await p1).toBeUndefined()

      const p2 = showAlert('Test alert')
      dialog.cancel()
      expect(await p2).toBeUndefined()

      showAlert('Test')
      dialog.confirm()
      expect(dialog.state.value.open).toBe(false)
    })
  })

  describe('showConfirm', () => {
    it('resolves true on confirm, false on cancel', async () => {
      showConfirm('Are you sure?')
      expect(dialog.state.value.open).toBe(true)
      expect(dialog.state.value.type).toBe('confirm')
      expect(dialog.state.value.message).toBe('Are you sure?')
      dialog.cancel()

      const p1 = showConfirm('Proceed?')
      dialog.confirm()
      expect(await p1).toBe(true)

      const p2 = showConfirm('Proceed?')
      dialog.cancel()
      expect(await p2).toBe(false)
    })

    it('closes dialog on confirm and cancel', () => {
      showConfirm('Test')
      dialog.confirm()
      expect(dialog.state.value.open).toBe(false)

      showConfirm('Test')
      dialog.cancel()
      expect(dialog.state.value.open).toBe(false)
    })
  })

  describe('showPrompt', () => {
    it('resolves with input value or null', async () => {
      showPrompt('Enter name:')
      expect(dialog.state.value.open).toBe(true)
      expect(dialog.state.value.type).toBe('prompt')
      expect(dialog.state.value.message).toBe('Enter name:')
      expect(dialog.state.value.defaultValue).toBe('')
      expect(dialog.state.value.inputValue).toBe('')
      dialog.cancel()

      showPrompt('Enter name:', 'John')
      expect(dialog.state.value.defaultValue).toBe('John')
      expect(dialog.state.value.inputValue).toBe('John')
      dialog.cancel()

      const p1 = showPrompt('Enter name:', 'default')
      dialog.updateInput('Alice')
      dialog.confirm()
      expect(await p1).toBe('Alice')

      const p2 = showPrompt('Enter name:', 'default')
      dialog.confirm()
      expect(await p2).toBe('default')

      const p3 = showPrompt('Enter name:', 'default')
      dialog.cancel()
      expect(await p3).toBeNull()
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
})
