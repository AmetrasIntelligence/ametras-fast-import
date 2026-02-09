import { ref, readonly } from 'vue'

type DialogType = 'alert' | 'confirm' | 'prompt'

interface DialogState {
  open: boolean
  type: DialogType
  message: string
  defaultValue: string
  inputValue: string
}

const state = ref<DialogState>({
  open: false,
  type: 'alert',
  message: '',
  defaultValue: '',
  inputValue: ''
})

let resolvePromise: ((value: unknown) => void) | null = null

function open(type: DialogType, message: string, defaultValue = ''): Promise<unknown> {
  return new Promise((resolve) => {
    resolvePromise = resolve
    state.value = {
      open: true,
      type,
      message,
      defaultValue,
      inputValue: defaultValue
    }
  })
}

function close(result: unknown) {
  state.value.open = false
  if (resolvePromise) {
    resolvePromise(result)
    resolvePromise = null
  }
}

export function showAlert(message: string): Promise<void> {
  return open('alert', message) as Promise<void>
}

export function showConfirm(message: string): Promise<boolean> {
  return open('confirm', message) as Promise<boolean>
}

export function showPrompt(message: string, defaultValue = ''): Promise<string | null> {
  return open('prompt', message, defaultValue) as Promise<string | null>
}

export function useDialogState() {
  return {
    state: readonly(state),
    updateInput(value: string) {
      state.value.inputValue = value
    },
    confirm() {
      if (state.value.type === 'alert') {
        close(undefined)
      } else if (state.value.type === 'confirm') {
        close(true)
      } else {
        close(state.value.inputValue)
      }
    },
    cancel() {
      if (state.value.type === 'confirm') {
        close(false)
      } else if (state.value.type === 'prompt') {
        close(null)
      } else {
        close(undefined)
      }
    }
  }
}
