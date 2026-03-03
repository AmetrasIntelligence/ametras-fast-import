import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mockApi } from '../../setup'
import { useProfilesStore } from '@/stores/profiles'
import { useSessionStore } from '@/stores/session'

function setupSession() {
  const session = useSessionStore()
  session.setEmbeddedMode({
    uid: 1,
    baseUrl: 'http://localhost:8069',
    db: 'test'
  })
  session.serverVersion = '16.0'
}

describe('ProfilesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('starts with empty profiles', () => {
      const store = useProfilesStore()
      expect(store.profiles.size).toBe(0)
    })

    it('is not loading', () => {
      const store = useProfilesStore()
      expect(store.loading).toBe(false)
    })

    it('has empty profile list', () => {
      const store = useProfilesStore()
      expect(store.profileList).toEqual([])
    })
  })

  describe('cacheProfile', () => {
    it('adds a profile to the cache', () => {
      const store = useProfilesStore()
      store.cacheProfile({
        id: 1,
        name: 'Test',
        version: '1.0',
        mappings: [],
        sequence: [],
        runSettings: {
          batchSize: 200, retryLimit: 3, retryDelayMs: 2000, stopOnFatalError: false,
          encoding: 'utf-8-sig', delimiter: ',', skipHeader: true, dryRun: false, lang: 'de_DE'
        },
        createdAt: 1000,
        updatedAt: 2000
      })
      expect(store.profiles.size).toBe(1)
      expect(store.getProfile(1)?.name).toBe('Test')
    })
  })

  describe('getProfile', () => {
    it('returns undefined for non-existent id', () => {
      const store = useProfilesStore()
      expect(store.getProfile(999)).toBeUndefined()
    })

    it('returns cached profile', () => {
      const store = useProfilesStore()
      store.cacheProfile({
        id: 5,
        name: 'Cached',
        version: '1.0',
        mappings: [],
        sequence: [],
        runSettings: {
          batchSize: 200, retryLimit: 3, retryDelayMs: 2000, stopOnFatalError: false,
          encoding: 'utf-8-sig', delimiter: ',', skipHeader: true, dryRun: false, lang: 'de_DE'
        },
        createdAt: 1000,
        updatedAt: 2000
      })
      expect(store.getProfile(5)?.name).toBe('Cached')
    })
  })

  describe('profileList', () => {
    it('sorts by updatedAt desc', () => {
      const store = useProfilesStore()
      store.cacheProfile({
        id: 1, name: 'Old', version: '1.0', mappings: [], sequence: [],
        runSettings: {
          batchSize: 200, retryLimit: 3, retryDelayMs: 2000, stopOnFatalError: false,
          encoding: 'utf-8-sig', delimiter: ',', skipHeader: true, dryRun: false, lang: 'de_DE'
        },
        createdAt: 1000, updatedAt: 1000
      })
      store.cacheProfile({
        id: 2, name: 'New', version: '1.0', mappings: [], sequence: [],
        runSettings: {
          batchSize: 200, retryLimit: 3, retryDelayMs: 2000, stopOnFatalError: false,
          encoding: 'utf-8-sig', delimiter: ',', skipHeader: true, dryRun: false, lang: 'de_DE'
        },
        createdAt: 2000, updatedAt: 3000
      })

      const list = store.profileList
      expect(list[0].name).toBe('New')
      expect(list[1].name).toBe('Old')
    })
  })

  describe('invalidateCache', () => {
    it('resets lastFetch to 0', () => {
      const store = useProfilesStore()
      store.lastFetch = Date.now()
      store.invalidateCache()
      expect(store.lastFetch).toBe(0)
    })
  })

  describe('loadProfiles', () => {
    it('fetches from server on first call', async () => {
      setupSession()
      const store = useProfilesStore()

      mockApi.odoo.call.mockResolvedValue({
        ok: true,
        result: [
          {
            id: 1,
            name: 'Server Profile',
            version: '1.0',
            description: '',
            odoo_min_version: '',
            derived_from: '',
            created_at: '2024-01-01T00:00:00',
            updated_at: '2024-01-02T00:00:00'
          }
        ]
      })

      await store.loadProfiles()

      expect(mockApi.odoo.call).toHaveBeenCalled()
      expect(store.profiles.size).toBe(1)
      expect(store.loading).toBe(false)
    })

    it('uses cache within TTL', async () => {
      setupSession()
      const store = useProfilesStore()

      mockApi.odoo.call.mockResolvedValue({ ok: true, result: [] })

      await store.loadProfiles()
      vi.clearAllMocks()
      mockApi.odoo.call.mockResolvedValue({ ok: true, result: [] })

      await store.loadProfiles() // Should use cache for server profiles
      // odoo.call may still be called for standalone profiles (ir.attachment),
      // but the server profile endpoint should NOT be called again
      const serverProfileCalls = mockApi.odoo.call.mock.calls.filter(
        (args: unknown[]) => (args[0] as { endpoint: string }).endpoint === '/ametras_fast_import/profile/list'
      )
      expect(serverProfileCalls).toHaveLength(0)
    })

    it('refetches when forced', async () => {
      setupSession()
      const store = useProfilesStore()

      mockApi.odoo.call.mockResolvedValue({ ok: true, result: [] })

      await store.loadProfiles()
      vi.clearAllMocks()

      mockApi.odoo.call.mockResolvedValue({ ok: true, result: [] })

      await store.loadProfiles(true) // Force refetch
      expect(mockApi.odoo.call).toHaveBeenCalled()
    })
  })

  describe('deleteProfile', () => {
    it('removes from cache after server delete', async () => {
      setupSession()
      const store = useProfilesStore()
      store.cacheProfile({
        id: 10, name: 'ToDelete', version: '1.0', mappings: [], sequence: [],
        runSettings: {
          batchSize: 200, retryLimit: 3, retryDelayMs: 2000, stopOnFatalError: false,
          encoding: 'utf-8-sig', delimiter: ',', skipHeader: true, dryRun: false, lang: 'de_DE'
        },
        createdAt: 1000, updatedAt: 2000
      })

      mockApi.odoo.call.mockResolvedValue({
        ok: true,
        result: { ok: true }
      })

      await store.deleteProfile(10)

      expect(store.profiles.has(10)).toBe(false)
    })
  })
})
