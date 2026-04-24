import { defineStore } from 'pinia'
import { shallowRef, computed } from 'vue'
import type { ParsedRow } from '@/importer/csvParser'
import type { BatchResult } from '@/importer/batchExecutor'

export interface PlatformCapabilities {
  dryRun: boolean
  rowValidation: boolean
  searchKeys: boolean
  serverLogs: boolean
  serverProfiles: boolean
  multipleWorkers: boolean
  lang: boolean
}

export type ExecuteBatchFn = (
  model: string,
  rows: ParsedRow[],
  options: { fieldMappings: Record<string, string>; searchKeys?: string[]; strict?: boolean },
  context: {
    dryRun?: boolean
    signal?: AbortSignal
    batchAdapter?: unknown
    timeoutEscalationLevel?: number
  }
) => Promise<BatchResult[]>

export interface PlatformConfig {
  executeBatch: ExecuteBatchFn
  maxWorkers: number
  batchSizeRange: { min: number; max: number }
  createBatchAdapter: ((maxBatchSize: number) => unknown) | null
  capabilities: PlatformCapabilities
  limitations: string[]
}

const ALL_CAPABLE: PlatformCapabilities = {
  dryRun: true,
  rowValidation: true,
  searchKeys: true,
  serverLogs: true,
  serverProfiles: true,
  multipleWorkers: true,
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

  const executeBatch = computed<ExecuteBatchFn>(() => {
    if (!config.value) throw new Error('Platform not configured')
    return config.value.executeBatch
  })

  const maxWorkers = computed<number>(() =>
    config.value?.maxWorkers ?? 4
  )

  const batchSizeRange = computed<{ min: number; max: number }>(() =>
    config.value?.batchSizeRange ?? { min: 1, max: 1000 }
  )

  const createBatchAdapter = computed<((maxBatchSize: number) => unknown) | null>(() =>
    config.value?.createBatchAdapter ?? null
  )

  return {
    config,
    configure,
    capabilities,
    limitations,
    executeBatch,
    maxWorkers,
    batchSizeRange,
    createBatchAdapter,
  }
})
