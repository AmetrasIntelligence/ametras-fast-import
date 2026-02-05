import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session'

export interface SavedMapping {
  id: string
  filenamePattern: string   // Simple glob: "customers.csv" or "*_partners.csv"
  model: string             // target Odoo model
  lastUsedAt: number
}

export const useSavedMappingsStore = defineStore('savedMappings', () => {
  const session = useSessionStore()
  const mappings = ref<SavedMapping[]>([])

  // Storage key scoped to server
  function getStorageKey(): string {
    return `savedMappings::${session.baseUrl}`
  }

  async function load() {
    if (!session.baseUrl) return
    const stored = await window.api.store.get(getStorageKey())
    if (stored) mappings.value = stored as SavedMapping[]
  }

  async function persist() {
    if (!session.baseUrl) return
    await window.api.store.set(
      getStorageKey(),
      JSON.parse(JSON.stringify(mappings.value))
    )
  }

  function addMapping(filenamePattern: string, model: string): SavedMapping {
    // Update existing if same pattern
    const existing = mappings.value.find(m => m.filenamePattern === filenamePattern)
    if (existing) {
      existing.model = model
      existing.lastUsedAt = Date.now()
      persist()
      return existing
    }

    const newMapping: SavedMapping = {
      id: crypto.randomUUID(),
      filenamePattern,
      model,
      lastUsedAt: Date.now()
    }
    mappings.value.push(newMapping)
    persist()
    return newMapping
  }

  function deleteMapping(id: string) {
    mappings.value = mappings.value.filter(m => m.id !== id)
    persist()
  }

  /**
   * Find a suggestion for a filename. Returns null if no match.
   * Never auto-applies - caller must confirm with user.
   */
  function findSuggestion(filename: string): SavedMapping | null {
    // Exact match first
    const exact = mappings.value.find(m => m.filenamePattern === filename)
    if (exact) return exact

    // Simple glob match (only * supported)
    for (const mapping of mappings.value) {
      if (mapping.filenamePattern.includes('*')) {
        const pattern = mapping.filenamePattern
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
        const regex = new RegExp(`^${pattern}$`, 'i')
        if (regex.test(filename)) return mapping
      }
    }

    return null
  }

  function markUsed(id: string) {
    const mapping = mappings.value.find(m => m.id === id)
    if (mapping) {
      mapping.lastUsedAt = Date.now()
      persist()
    }
  }

  return {
    mappings,
    load,
    addMapping,
    deleteMapping,
    findSuggestion,
    markUsed
  }
})
