import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mockApi } from '../../setup'
import { mockServerProfiles, mockOdooResponses } from '../../fixtures'
import { useSessionStore } from '@/stores/session'

describe('SessionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('starts in standalone mode', () => {
      const store = useSessionStore()
      expect(store.mode).toBe('standalone')
    })

    it('is not authenticated initially', () => {
      const store = useSessionStore()
      expect(store.isAuthenticated).toBe(false)
      expect(store.uid).toBeNull()
    })

    it('has no current server', () => {
      const store = useSessionStore()
      expect(store.currentServer).toBeNull()
      expect(store.baseUrl).toBeNull()
    })

    it('has empty saved profiles', () => {
      const store = useSessionStore()
      expect(store.savedProfiles).toEqual([])
    })
  })

  describe('setAuthenticated', () => {
    it('sets session state correctly', () => {
      const store = useSessionStore()
      const profile = mockServerProfiles[0]

      store.setAuthenticated(profile, mockOdooResponses.authSuccess.uid, mockOdooResponses.authSuccess.server_version)

      expect(store.isAuthenticated).toBe(true)
      expect(store.uid).toBe(mockOdooResponses.authSuccess.uid)
      expect(store.serverVersion).toBe(mockOdooResponses.authSuccess.server_version)
      expect(store.currentServer).toEqual(profile)
      expect(store.baseUrl).toBe(profile.baseUrl)
    })
  })

  describe('logout', () => {
    it('clears session state', () => {
      const store = useSessionStore()
      store.setAuthenticated(mockServerProfiles[0], 2, '16.0')

      store.logout()

      expect(store.isAuthenticated).toBe(false)
      expect(store.uid).toBeNull()
      expect(store.serverVersion).toBeNull()
      expect(store.currentServer).toBeNull()
    })

    it('preserves saved profiles after logout', () => {
      const store = useSessionStore()
      store.savedProfiles.push(mockServerProfiles[0])
      store.setAuthenticated(mockServerProfiles[0], 2, '16.0')

      store.logout()

      expect(store.savedProfiles).toHaveLength(1)
    })
  })

  describe('loadProfiles', () => {
    it('loads profiles from store', async () => {
      mockApi.store.get.mockResolvedValue(mockServerProfiles)

      const store = useSessionStore()
      await store.loadProfiles()

      expect(store.savedProfiles).toEqual(mockServerProfiles)
    })

    it('handles empty store', async () => {
      mockApi.store.get.mockResolvedValue(null)

      const store = useSessionStore()
      await store.loadProfiles()

      expect(store.savedProfiles).toEqual([])
    })
  })

  describe('embedded mode', () => {
    it('sets embedded mode correctly', () => {
      const store = useSessionStore()

      store.setEmbeddedMode({
        uid: 5,
        baseUrl: 'https://embedded.odoo.com',
        db: 'embedded_db'
      })

      expect(store.mode).toBe('embedded')
      expect(store.isEmbedded).toBe(true)
      expect(store.isAuthenticated).toBe(true)
      expect(store.uid).toBe(5)
      expect(store.baseUrl).toBe('https://embedded.odoo.com')
    })
  })
})
