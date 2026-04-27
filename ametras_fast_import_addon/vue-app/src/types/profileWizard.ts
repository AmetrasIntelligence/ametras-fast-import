import type { RunSettings } from '@/stores/config'
import type { ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import type { FieldMapping } from '@/types/fieldMapping'

export interface ProfileWizardSeed {
  name?: string
  version?: string
  description?: string
  odooMinVersion?: string
  mappings: ProfileMapping[]
  sequence: ProfileSequenceItem[]
  runSettings: RunSettings
  richFieldMappings?: FieldMapping[]
  samples?: Array<{
    filename: string
    headers: string[]
  }>
}
