import { defineStore } from 'pinia'
import { shallowRef, computed } from 'vue'

export interface PlatformCapabilities {
  dryRun: boolean
  rowValidation: boolean
  searchKeys: boolean
  serverLogs: boolean
  serverProfiles: boolean
  lang: boolean
}

export interface PlatformConfig {
  capabilities: PlatformCapabilities
  limitations: string[]
}

const ALL_CAPABLE: PlatformCapabilities = {
  dryRun: true,
  rowValidation: true,
  searchKeys: true,
  serverLogs: true,
  serverProfiles: true,
  lang: true,
}

export const usePlatformStore = defineStore('platform', () => {
  const config = shallowRef<PlatformConfig | null>(null)

  function configure(newConfig: PlatformConfig) {
    config.value = newConfig
  }

  const capabilities = computed<PlatformCapabilities>(() =>
    config.value?.capabilities ?? ALL_CAPABLE
  )

  const limitations = computed<string[]>(() =>
    config.value?.limitations ?? []
  )

  return {
    config,
    configure,
    capabilities,
    limitations,
  }
})
