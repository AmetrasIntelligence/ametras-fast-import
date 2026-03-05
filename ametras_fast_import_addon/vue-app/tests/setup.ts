import { vi } from 'vitest'
import { config } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// Setup Pinia for each test
beforeEach(() => {
  setActivePinia(createPinia())
})

// Track active mock streams for async streaming API
const mockStreams = new Map<string, { chunks: string[]; currentIndex: number }>()
let mockStreamIdCounter = 0

// Mock window.api for Electron IPC
const mockApi = {
  files: {
    select: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockResolvedValue(''),
    readHead: vi.fn().mockResolvedValue(''),
    countLines: vi.fn().mockResolvedValue(0),
    streamChunks: vi.fn().mockResolvedValue(undefined),
    // Async streaming API with backpressure
    streamStart: vi.fn().mockImplementation(async () => {
      const streamId = `mock-stream-${++mockStreamIdCounter}`
      mockStreams.set(streamId, { chunks: [], currentIndex: 0 })
      return streamId
    }),
    streamNext: vi.fn().mockImplementation(async (streamId: string) => {
      const stream = mockStreams.get(streamId)
      if (!stream) return { data: '', done: true }
      if (stream.currentIndex >= stream.chunks.length) {
        return { data: '', done: true }
      }
      const data = stream.chunks[stream.currentIndex++]
      return { data, done: false }
    }),
    streamClose: vi.fn().mockImplementation(async (streamId: string) => {
      mockStreams.delete(streamId)
    })
  },
  odoo: {
    call: vi.fn().mockResolvedValue({}),
    authenticate: vi.fn().mockResolvedValue({
      uid: 1,
      session_id: 'test-session',
      server_version: '16.0'
    }),
    listDatabases: vi.fn().mockResolvedValue({ ok: true, databases: [] }),
    ping: vi.fn().mockResolvedValue({ ok: true }),
    getEncryptionInfo: vi.fn().mockResolvedValue({ available: false, platform: 'test' })
  },
  store: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined)
  },
  profile: {
    selectZip: vi.fn().mockResolvedValue(null),
    upload: vi.fn().mockResolvedValue({ ok: false, error: 'Not mocked' }),
    export: vi.fn().mockResolvedValue(false)
  },
  standalone: {
    detectAddon: vi.fn().mockResolvedValue({ available: true, version: '1.0.0', odooVersion: '16.0' }),
    load: vi.fn().mockResolvedValue({ ok: true, ids: [], messages: [] }),
    getOdooVersion: vi.fn().mockResolvedValue({ version: '16.0' })
  }
}

// @ts-expect-error - mock window for tests
globalThis.window = {
  api: mockApi,
  crypto: {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9)
  }
}

// Export for tests to modify mocks
export { mockApi }

/**
 * Helper to set up mock stream with CSV data.
 * Call this before running tests that use parseCSVBatched.
 * Also configures readHead and countLines for analyzeCSV compatibility.
 * @param csvData - Single CSV string or array of CSV chunk strings
 */
export function setupMockStream(csvData: string | string[]): void {
  const chunks = Array.isArray(csvData) ? csvData : [csvData]
  mockApi.files.streamStart.mockImplementation(async () => {
    const streamId = `mock-stream-${++mockStreamIdCounter}`
    mockStreams.set(streamId, { chunks, currentIndex: 0 })
    return streamId
  })

  // Also configure readHead and countLines so analyzeCSV works correctly.
  // Combine all chunks to derive the full CSV content for analysis.
  const fullContent = chunks.join('\n')
  const lineCount = fullContent.split('\n').filter(l => l.trim().length > 0).length
  mockApi.files.readHead.mockResolvedValue(fullContent.slice(0, 10240))
  mockApi.files.countLines.mockResolvedValue(lineCount)
}

/**
 * Reset mock streams state.
 */
export function resetMockStreams(): void {
  mockStreams.clear()
  mockStreamIdCounter = 0
}

// Configure Vue Test Utils
config.global.stubs = {
  RouterLink: true,
  RouterView: true
}
