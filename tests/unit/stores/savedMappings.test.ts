import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mockApi } from '../../setup'
import { useSavedMappingsStore } from '@/stores/savedMappings'
import { useSessionStore } from '@/stores/session'
import { mockOdooResponses, mockServerProfiles } from '../../fixtures'

describe('SavedMappingsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  function loginFirst() {
    // Set up authenticated session so baseUrl is available
    const session = useSessionStore()
    mockApi.odoo.authenticate.mockResolvedValue(mockOdooResponses.authSuccess)
    return session.login(mockServerProfiles[0], 'password')
  }

  describe('initial state', () => {
    it('starts with empty mappings', () => {
      const store = useSavedMappingsStore()
      expect(store.mappings).toEqual([])
    })
  })

  describe('addMapping', () => {
    it('adds a new mapping', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()

      const mapping = store.addMapping('partners.csv', 'res.partner')

      expect(mapping.filenamePattern).toBe('partners.csv')
      expect(mapping.model).toBe('res.partner')
      expect(mapping.id).toBeDefined()
      expect(store.mappings).toHaveLength(1)
    })

    it('updates existing mapping with same pattern', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()

      store.addMapping('partners.csv', 'res.partner')
      store.addMapping('partners.csv', 'res.users')

      expect(store.mappings).toHaveLength(1)
      expect(store.mappings[0].model).toBe('res.users')
    })

    it('persists to store', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()
      vi.clearAllMocks()

      store.addMapping('partners.csv', 'res.partner')

      expect(mockApi.store.set).toHaveBeenCalled()
    })
  })

  describe('deleteMapping', () => {
    it('removes a mapping', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()

      const mapping = store.addMapping('partners.csv', 'res.partner')
      store.deleteMapping(mapping.id)

      expect(store.mappings).toHaveLength(0)
    })
  })

  describe('findSuggestion', () => {
    it('finds exact match', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()

      store.addMapping('partners.csv', 'res.partner')

      const suggestion = store.findSuggestion('partners.csv')
      expect(suggestion).not.toBeNull()
      expect(suggestion!.model).toBe('res.partner')
    })

    it('finds glob match', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()

      store.addMapping('*_partners.csv', 'res.partner')

      const suggestion = store.findSuggestion('2024_partners.csv')
      expect(suggestion).not.toBeNull()
      expect(suggestion!.model).toBe('res.partner')
    })

    it('returns null for no match', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()

      store.addMapping('partners.csv', 'res.partner')

      const suggestion = store.findSuggestion('products.csv')
      expect(suggestion).toBeNull()
    })

    it('prefers exact match over glob', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()

      store.addMapping('*.csv', 'product.template')
      store.addMapping('partners.csv', 'res.partner')

      const suggestion = store.findSuggestion('partners.csv')
      expect(suggestion!.model).toBe('res.partner')
    })
  })

  describe('markUsed', () => {
    it('updates lastUsedAt timestamp', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()

      const mapping = store.addMapping('partners.csv', 'res.partner')
      const originalTimestamp = mapping.lastUsedAt

      // Wait a tick
      await new Promise(r => setTimeout(r, 10))

      store.markUsed(mapping.id)

      expect(store.mappings[0].lastUsedAt).toBeGreaterThanOrEqual(originalTimestamp)
    })
  })

  describe('load', () => {
    it('loads from per-server storage key', async () => {
      await loginFirst()
      const session = useSessionStore()

      const stored = [
        { id: '1', filenamePattern: 'test.csv', model: 'res.partner', lastUsedAt: 1000 }
      ]
      mockApi.store.get.mockResolvedValue(stored)

      const store = useSavedMappingsStore()
      await store.load()

      expect(mockApi.store.get).toHaveBeenCalledWith(`savedMappings::${session.baseUrl}`)
      expect(store.mappings).toEqual(stored)
    })

    it('does nothing when not connected', async () => {
      const store = useSavedMappingsStore()
      await store.load()

      expect(store.mappings).toEqual([])
    })
  })
})
