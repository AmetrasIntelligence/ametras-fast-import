import { ref, computed } from 'vue'
import type { RunSettings } from '@/stores/config'
import type { ImportProfile, ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'
import type { FieldMapping } from '@/types/fieldMapping'
import { createRunConfig, type RunConfig } from '@/types/runConfig'

export function useRunConfig(profile: ImportProfile) {
  const runConfig = ref<RunConfig>(createRunConfig(profile.id))

  // ── Effective (merged) values ─────────────────────────────────────

  const effectiveRunSettings = computed<RunSettings>(() => {
    return {
      ...profile.runSettings,
      ...runConfig.value.runSettingsOverride
    }
  })

  const effectiveMappings = computed<ProfileMapping[]>(() => {
    return profile.mappings.map(m => {
      const override = runConfig.value.mappingsOverride.get(m.filename)
      if (override) {
        return { ...m, ...override }
      }
      return m
    })
  })

  const effectiveSequence = computed<ProfileSequenceItem[]>(() => {
    if (runConfig.value.sequenceOverride !== null) {
      return runConfig.value.sequenceOverride
    }
    return profile.sequence
  })

  const effectiveFieldMappings = computed<FieldMapping[]>(() => {
    const base = profile.richFieldMappings || []
    const overrideMap = runConfig.value.fieldMappingsOverride

    if (overrideMap.size === 0) return base

    // For each file, if there's an override, replace that file's mappings entirely
    const overriddenFiles = new Set(overrideMap.keys())
    const result: FieldMapping[] = []

    // Keep non-overridden file mappings from base
    for (const fm of base) {
      if (!overriddenFiles.has(fm.filename)) {
        result.push(fm)
      }
    }

    // Add overrides
    for (const [, mappings] of overrideMap) {
      result.push(...mappings)
    }

    return result
  })

  // ── Override setters ──────────────────────────────────────────────

  function setRunSettingsOverride(overrides: Partial<RunSettings>) {
    runConfig.value.runSettingsOverride = {
      ...runConfig.value.runSettingsOverride,
      ...overrides
    }
  }

  function setMappingOverride(filename: string, override: Partial<ProfileMapping>) {
    const newMap = new Map(runConfig.value.mappingsOverride)
    newMap.set(filename, override)
    runConfig.value.mappingsOverride = newMap
  }

  function setSequenceOverride(sequence: ProfileSequenceItem[]) {
    runConfig.value.sequenceOverride = sequence
  }

  function setFieldMappingsOverride(filename: string, mappings: FieldMapping[]) {
    const newMap = new Map(runConfig.value.fieldMappingsOverride)
    newMap.set(filename, mappings)
    runConfig.value.fieldMappingsOverride = newMap
  }

  // ── Reset functions ───────────────────────────────────────────────

  function resetRunSettingsOverride() {
    runConfig.value.runSettingsOverride = {}
  }

  function resetMappingsOverride() {
    runConfig.value.mappingsOverride = new Map()
  }

  function resetSequenceOverride() {
    runConfig.value.sequenceOverride = null
  }

  function resetFieldMappingsOverride() {
    runConfig.value.fieldMappingsOverride = new Map()
  }

  function resetAllOverrides() {
    resetRunSettingsOverride()
    resetMappingsOverride()
    resetSequenceOverride()
    resetFieldMappingsOverride()
  }

  // ── Status ────────────────────────────────────────────────────────

  const hasOverrides = computed(() => {
    return (
      Object.keys(runConfig.value.runSettingsOverride).length > 0 ||
      runConfig.value.mappingsOverride.size > 0 ||
      runConfig.value.sequenceOverride !== null ||
      runConfig.value.fieldMappingsOverride.size > 0
    )
  })

  return {
    runConfig,
    effectiveRunSettings,
    effectiveMappings,
    effectiveSequence,
    effectiveFieldMappings,
    setRunSettingsOverride,
    setMappingOverride,
    setSequenceOverride,
    setFieldMappingsOverride,
    resetRunSettingsOverride,
    resetMappingsOverride,
    resetSequenceOverride,
    resetFieldMappingsOverride,
    resetAllOverrides,
    hasOverrides
  }
}
