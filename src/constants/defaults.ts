import type { RunSettings } from '@/stores/config'

/**
 * Default run settings used across the application.
 * Single source of truth for initial configuration values.
 */
export const DEFAULT_RUN_SETTINGS: RunSettings = {
  batchSize: 200,
  retryLimit: 3,
  retryDelayMs: 500,
  stopOnFatalError: false,
  encoding: 'utf-8-sig',
  delimiter: ',',
  skipHeader: true,
  dryRun: false,
  lang: 'de_DE',
  workers: 1,
  strict: true
}
