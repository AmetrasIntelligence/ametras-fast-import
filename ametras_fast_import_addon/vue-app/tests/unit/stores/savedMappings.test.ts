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
    const session = useSessionStore()
    session.setAuthenticated(
      mockServerProfiles[0],
      mockOdooResponses.authSuccess.uid,
      mockOdooResponses.authSuccess.server_version
    )
  }

  describe('initial state', () => {
    it('starts with empty mappings', () => {
      const store = useSavedMappingsStore()
      expect(store.mappings).toEqual([])
    })
  })

  describe('addMapping', () => {
    it('adds, updates, and persists mappings', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()

      const mapping = await store.addMapping('partners.csv', 'res.partner')
      expect(mapping.filenamePattern).toBe('partners.csv')
      expect(mapping.model).toBe('res.partner')
      expect(mapping.id).toBeDefined()
      expect(store.mappings).toHaveLength(1)

      await store.addMapping('partners.csv', 'res.users')
      expect(store.mappings).toHaveLength(1)
      expect(store.mappings[0].model).toBe('res.users')

      vi.clearAllMocks()
      await store.addMapping('products.csv', 'product.template')
      expect(mockApi.store.set).toHaveBeenCalled()
    })
  })

  describe('findSuggestion', () => {
    it('finds exact, glob, and no match', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()

      await store.addMapping('partners.csv', 'res.partner')
      expect(store.findSuggestion('partners.csv')!.model).toBe('res.partner')
      expect(store.findSuggestion('products.csv')).toBeNull()

      await store.addMapping('*_data.csv', 'product.template')
      expect(store.findSuggestion('2024_data.csv')!.model).toBe('product.template')
    })

    it('prefers exact match over glob', async () => {
      await loginFirst()
      const store = useSavedMappingsStore()

      await store.addMapping('*.csv', 'product.template')
      await store.addMapping('partners.csv', 'res.partner')

      expect(store.findSuggestion('partners.csv')!.model).toBe('res.partner')
    })
  })

  describe('load', () => {
    it('loads from per-server storage key when connected', async () => {
      await loginFirst()
      const session = useSessionStore()

      const stored = [
        { id: '1', filenamePattern: 'test.csv', model: 'res.partner' }
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
