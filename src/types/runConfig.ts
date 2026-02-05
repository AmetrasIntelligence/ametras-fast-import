import type { RunSettings } from '@/stores/config'
import type { ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import type { FieldMapping } from '@/types/fieldMapping'

export interface RunConfig {
  id: string
  profileId: number
  runSettingsOverride: Partial<RunSettings>
  mappingsOverride: Map<string, Partial<ProfileMapping>>
  sequenceOverride: ProfileSequenceItem[] | null
  fieldMappingsOverride: Map<string, FieldMapping[]>
  createdAt: number
}

export function createRunConfig(profileId: number): RunConfig {
  return {
    id: crypto.randomUUID(),
    profileId,
    runSettingsOverride: {},
    mappingsOverride: new Map(),
    sequenceOverride: null,
    fieldMappingsOverride: new Map(),
    createdAt: Date.now()
  }
}
