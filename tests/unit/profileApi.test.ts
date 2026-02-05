import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mockApi } from '../setup'
import { useSessionStore } from '@/stores/session'

// We need to set up session before importing profileApi functions
// since they call useSessionStore() internally
async function setupSession() {
  const session = useSessionStore()
  session.currentServer = {
    id: 'test',
    name: 'admin',
    baseUrl: 'http://localhost:8069',
    db: 'test'
  }
  session.uid = 1
  session.serverVersion = '16.0'
}

describe('profileApi', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  describe('fetchProfiles', () => {
    it('calls the correct endpoint and returns profiles', async () => {
      await setupSession()

      mockApi.odoo.call.mockResolvedValue({
        ok: true,
        result: [
          {
            id: 1,
            name: 'Test Profile',
            version: '1.0',
            description: '',
            odoo_min_version: '',
            derived_from: '',
            created_at: '2024-01-01T00:00:00',
            updated_at: '2024-01-02T00:00:00'
          }
        ]
      })

      const { fetchProfiles } = await import('@/api/profileApi')
      const profiles = await fetchProfiles()

      expect(mockApi.odoo.call).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:8069',
        endpoint: '/csv_import/profile/list',
        params: {}
      })

      expect(profiles).toHaveLength(1)
      expect(profiles[0].id).toBe(1)
      expect(profiles[0].name).toBe('Test Profile')
    })

    it('throws on error response', async () => {
      await setupSession()

      mockApi.odoo.call.mockResolvedValue({
        ok: false,
        error: 'Server error'
      })

      const { fetchProfiles } = await import('@/api/profileApi')
      await expect(fetchProfiles()).rejects.toThrow('Server error')
    })
  })

  describe('fetchProfile', () => {
    it('fetches a single profile with full data', async () => {
      await setupSession()

      mockApi.odoo.call.mockResolvedValue({
        ok: true,
        result: {
          id: 42,
          name: 'Full Profile',
          version: '2.0',
          description: 'Test',
          odoo_min_version: '16.0',
          derived_from: '',
          created_at: '2024-01-01T00:00:00',
          updated_at: '2024-01-02T00:00:00',
          mappings: [{ filename: 'a.csv', model: 'res.partner' }],
          sequence: [{ order: 1, filename: 'a.csv' }],
          run_settings: { batchSize: '100', retryLimit: '2' },
          field_mappings: []
        }
      })

      const { fetchProfile } = await import('@/api/profileApi')
      const profile = await fetchProfile(42)

      expect(mockApi.odoo.call).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:8069',
        endpoint: '/csv_import/profile/42',
        params: {}
      })

      expect(profile.id).toBe(42)
      expect(profile.name).toBe('Full Profile')
      expect(profile.mappings).toHaveLength(1)
      expect(profile.runSettings.batchSize).toBe(100)
    })
  })

  describe('deleteProfile', () => {
    it('calls the delete endpoint', async () => {
      await setupSession()

      mockApi.odoo.call.mockResolvedValue({
        ok: true,
        result: { ok: true }
      })

      const { deleteProfile } = await import('@/api/profileApi')
      await deleteProfile(5)

      expect(mockApi.odoo.call).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:8069',
        endpoint: '/csv_import/profile/5/delete',
        params: {}
      })
    })

    it('throws when profile not found', async () => {
      await setupSession()

      mockApi.odoo.call.mockResolvedValue({
        ok: true,
        result: { error: 'Profile not found' }
      })

      const { deleteProfile } = await import('@/api/profileApi')
      await expect(deleteProfile(999)).rejects.toThrow('Profile not found')
    })
  })

  describe('error handling', () => {
    it('throws when not connected', async () => {
      // Don't set up session
      const { fetchProfiles } = await import('@/api/profileApi')
      await expect(fetchProfiles()).rejects.toThrow('Not connected')
    })
  })
})
