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

  describe('login', () => {
    it('authenticates successfully', async () => {
      mockApi.odoo.authenticate.mockResolvedValue(mockOdooResponses.authSuccess)

      const store = useSessionStore()
      const profile = mockServerProfiles[0]

      await store.login(profile, 'password123')

      expect(store.isAuthenticated).toBe(true)
      expect(store.uid).toBe(mockOdooResponses.authSuccess.uid)
      expect(store.serverVersion).toBe(mockOdooResponses.authSuccess.server_version)
      expect(store.currentServer).toEqual(profile)
      expect(store.baseUrl).toBe(profile.baseUrl)
    })

    it('calls authenticate with correct params', async () => {
      mockApi.odoo.authenticate.mockResolvedValue(mockOdooResponses.authSuccess)

      const store = useSessionStore()
      const profile = mockServerProfiles[0]

      await store.login(profile, 'password123')

      expect(mockApi.odoo.authenticate).toHaveBeenCalledWith({
        baseUrl: profile.baseUrl,
        db: profile.db,
        login: profile.name,
        password: 'password123'
      })
    })

    it('saves profile on successful login', async () => {
      mockApi.odoo.authenticate.mockResolvedValue(mockOdooResponses.authSuccess)

      const store = useSessionStore()
      const profile = mockServerProfiles[0]

      await store.login(profile, 'password123')

      expect(store.savedProfiles).toContainEqual(profile)
      expect(mockApi.store.set).toHaveBeenCalledWith('profiles', [profile])
    })

    it('does not duplicate saved profiles', async () => {
      mockApi.odoo.authenticate.mockResolvedValue(mockOdooResponses.authSuccess)

      const store = useSessionStore()
      const profile = mockServerProfiles[0]

      await store.login(profile, 'password123')
      await store.login(profile, 'password123')

      expect(store.savedProfiles).toHaveLength(1)
    })

    it('throws on authentication failure', async () => {
      mockApi.odoo.authenticate.mockResolvedValue(mockOdooResponses.authFailed)

      const store = useSessionStore()
      const profile = mockServerProfiles[0]

      await expect(store.login(profile, 'wrongpassword')).rejects.toThrow('Invalid credentials')
      expect(store.isAuthenticated).toBe(false)
    })
  })

  describe('logout', () => {
    it('clears session state', async () => {
      mockApi.odoo.authenticate.mockResolvedValue(mockOdooResponses.authSuccess)

      const store = useSessionStore()
      await store.login(mockServerProfiles[0], 'password')

      store.logout()

      expect(store.isAuthenticated).toBe(false)
      expect(store.uid).toBeNull()
      expect(store.serverVersion).toBeNull()
      expect(store.currentServer).toBeNull()
    })

    it('preserves saved profiles after logout', async () => {
      mockApi.odoo.authenticate.mockResolvedValue(mockOdooResponses.authSuccess)

      const store = useSessionStore()
      await store.login(mockServerProfiles[0], 'password')

      const savedBefore = store.savedProfiles.length
      store.logout()

      expect(store.savedProfiles).toHaveLength(savedBefore)
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

  describe('multi-server support', () => {
    it('can login to multiple servers', async () => {
      mockApi.odoo.authenticate.mockResolvedValue(mockOdooResponses.authSuccess)

      const store = useSessionStore()

      await store.login(mockServerProfiles[0], 'password')
      expect(store.savedProfiles).toHaveLength(1)

      store.logout()

      await store.login(mockServerProfiles[1], 'password')
      expect(store.savedProfiles).toHaveLength(2)

      store.logout()

      await store.login(mockServerProfiles[2], 'password')
      expect(store.savedProfiles).toHaveLength(3)
    })
  })
})
