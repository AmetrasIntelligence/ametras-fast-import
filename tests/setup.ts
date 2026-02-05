import { vi } from 'vitest'
import { config } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// Setup Pinia for each test
beforeEach(() => {
  setActivePinia(createPinia())
})

// Mock window.api for Electron IPC
const mockApi = {
  files: {
    select: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockResolvedValue(''),
    readHead: vi.fn().mockResolvedValue(''),
    countLines: vi.fn().mockResolvedValue(0),
    streamChunks: vi.fn().mockResolvedValue(undefined)
  },
  odoo: {
    call: vi.fn().mockResolvedValue({}),
    authenticate: vi.fn().mockResolvedValue({
      uid: 1,
      session_id: 'test-session',
      server_version: '16.0'
    }),
    listDatabases: vi.fn().mockResolvedValue({ ok: true, databases: [] })
  },
  store: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined)
  },
  profile: {
    selectZip: vi.fn().mockResolvedValue(null),
    upload: vi.fn().mockResolvedValue({ ok: false, error: 'Not mocked' }),
    export: vi.fn().mockResolvedValue(false)
  }
}

// @ts-ignore
globalThis.window = {
  api: mockApi,
  crypto: {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9)
  }
}

// Export for tests to modify mocks
export { mockApi }

// Configure Vue Test Utils
config.global.stubs = {
  RouterLink: true,
  RouterView: true
}
