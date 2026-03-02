<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ImportProfile } from '@/types/importProfile'
import type { RunConfig } from '@/types/runConfig'
import type { RunSettings } from '@/stores/config'
import { serializeTransform } from '@/types/fieldMapping'
import ProfileEditorSettings from './ProfileEditorSettings.vue'

const { t } = useI18n()

const props = defineProps<{
  profile: ImportProfile
  runConfig: RunConfig
  effectiveRunSettings: RunSettings
  effectiveMappings: ImportProfile['mappings']
  effectiveSequence: ImportProfile['sequence']
  hasOverrides: boolean
}>()

const emit = defineEmits<{
  'update:runSettings': [overrides: Partial<RunSettings>]
  'reset-all': []
}>()

type Tab = 'settings' | 'mappings' | 'sequence' | 'field-mappings'
const activeTab = ref<Tab>('settings')

// Note: Tab labels use computed for reactivity with i18n
const tabs = computed(() => [
  { key: 'settings' as Tab, label: t('profileEditor.tabs.settings') },
  { key: 'mappings' as Tab, label: t('profileEditor.tabs.mappings') },
  { key: 'sequence' as Tab, label: t('profileEditor.tabs.sequence') },
  { key: 'field-mappings' as Tab, label: t('profileEditor.tabs.fieldMappings') }
])

const hasSettingsOverrides = computed(() =>
  Object.keys(props.runConfig.runSettingsOverride).length > 0
)

const hasMappingsOverrides = computed(() =>
  props.runConfig.mappingsOverride.size > 0
)

const hasSequenceOverride = computed(() =>
  props.runConfig.sequenceOverride !== null
)

const hasFieldMappingsOverrides = computed(() =>
  props.runConfig.fieldMappingsOverride.size > 0
)

function isOverridden(tab: Tab): boolean {
  switch (tab) {
    case 'settings': return hasSettingsOverrides.value
    case 'mappings': return hasMappingsOverrides.value
    case 'sequence': return hasSequenceOverride.value
    case 'field-mappings': return hasFieldMappingsOverrides.value
  }
}

function updateSetting(key: string, value: unknown) {
  emit('update:runSettings', { [key]: value })
}

const fieldMappings = computed(() => props.profile.richFieldMappings || [])
</script>

<template>
  <div class="csv-profile-editor">
    <!-- Tab Buttons -->
    <div class="csv-profile-editor__tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="csv-profile-editor__tab"
        :class="{ 'csv-profile-editor__tab--active': activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
        <span
          v-if="isOverridden(tab.key)"
          class="csv-profile-editor__override-dot"
          :title="$t('profileEditor.hasOverrides')"
        ></span>
      </button>
    </div>

    <!-- Settings Tab -->
    <div v-show="activeTab === 'settings'" class="csv-profile-editor__content">
      <ProfileEditorSettings
        :effective-run-settings="effectiveRunSettings"
        :run-config="runConfig"
        @update:setting="updateSetting"
      />
    </div>

    <!-- Mappings Tab -->
    <div v-show="activeTab === 'mappings'" class="csv-profile-editor__content">
      <div v-if="effectiveMappings.length === 0" class="text-center py-3 text-body-secondary small">
        {{ $t('profileEditor.noMappings') }}
      </div>
      <table v-else class="table table-sm small mb-0">
        <thead>
          <tr>
            <th class="text-start fw-medium">{{ $t('profileEditor.filename') }}</th>
            <th class="text-start fw-medium">{{ $t('profileEditor.model') }}</th>
            <th class="text-center" style="width: 2rem;"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="mapping in effectiveMappings"
            :key="mapping.filename"
          >
            <td class="font-monospace" style="font-size: 0.75rem;">{{ mapping.filename }}</td>
            <td style="font-size: 0.75rem;">{{ mapping.model }}</td>
            <td class="text-center">
              <span
                v-if="runConfig.mappingsOverride.has(mapping.filename)"
                class="csv-override-indicator"
                title="Overridden"
              >*</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Sequence Tab -->
    <div v-show="activeTab === 'sequence'" class="csv-profile-editor__content">
      <div v-if="effectiveSequence.length === 0" class="text-center py-3 text-body-secondary small">
        {{ $t('profileEditor.noSequence') }}
      </div>
      <table v-else class="table table-sm small mb-0">
        <thead>
          <tr>
            <th class="text-start fw-medium" style="width: 4rem;">#</th>
            <th class="text-start fw-medium">{{ $t('profileEditor.filename') }}</th>
            <th class="text-start fw-medium">{{ $t('profileEditor.requires') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in effectiveSequence"
            :key="item.filename"
          >
            <td class="text-body-secondary">{{ item.order }}</td>
            <td class="font-monospace" style="font-size: 0.75rem;">{{ item.filename }}</td>
            <td class="text-body-secondary" style="font-size: 0.75rem;">
              {{ item.requires?.join(', ') || '-' }}
            </td>
          </tr>
        </tbody>
      </table>
      <small
        v-if="hasSequenceOverride"
        class="text-warning d-block mt-2 px-3"
      >
        {{ $t('profileEditor.sequenceOverridden') }}
      </small>
    </div>

    <!-- Field Mappings Tab -->
    <div v-show="activeTab === 'field-mappings'" class="csv-profile-editor__content">
      <div v-if="fieldMappings.length === 0" class="text-center py-3 text-body-secondary small">
        {{ $t('profileEditor.noFieldMappings') }}
      </div>
      <table v-else class="table table-sm small mb-0">
        <thead>
          <tr>
            <th class="text-start fw-medium">File</th>
            <th class="text-start fw-medium">CSV Header</th>
            <th class="text-start fw-medium">Odoo Field</th>
            <th class="text-center fw-medium" style="width: 3rem;">Req</th>
            <th class="text-start fw-medium">Transform</th>
            <th class="text-center" style="width: 2rem;"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(fm, idx) in fieldMappings"
            :key="`${fm.filename}-${fm.csvHeader}-${idx}`"
          >
            <td class="font-monospace" style="font-size: 0.75rem;">{{ fm.filename }}</td>
            <td style="font-size: 0.75rem;">{{ fm.csvHeader }}</td>
            <td class="font-monospace" style="font-size: 0.75rem;">{{ fm.odooField }}</td>
            <td class="text-center">
              <span v-if="fm.required" class="text-warning">Yes</span>
              <span v-else class="text-body-secondary">-</span>
            </td>
            <td class="text-body-secondary" style="font-size: 0.75rem;">
              {{ fm.transform ? serializeTransform(fm.transform) : '-' }}
            </td>
            <td class="text-center">
              <span
                v-if="runConfig.fieldMappingsOverride.has(fm.filename)"
                class="csv-override-indicator"
                title="Overridden"
              >*</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.csv-profile-editor {
  background: var(--bs-body-bg);
}
.csv-profile-editor__tabs {
  display: flex;
  border-bottom: 1px solid var(--bs-border-color);
  background: var(--bs-tertiary-bg);
}
.csv-profile-editor__tab {
  position: relative;
  padding: 0.5rem 1rem;
  border: none;
  background: none;
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
  color: var(--bs-secondary-color);
  border-bottom: 2px solid transparent;
}
.csv-profile-editor__tab:hover {
  color: var(--bs-body-color);
  background: var(--bs-secondary-bg-subtle);
}
.csv-profile-editor__tab--active {
  color: var(--bs-primary);
  border-bottom-color: var(--bs-primary);
}
.csv-profile-editor__override-dot {
  position: absolute;
  top: 0.375rem;
  right: 0.375rem;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--bs-warning);
}
.csv-profile-editor__content {
  padding: 0.75rem;
}
.csv-override-indicator {
  color: var(--bs-warning);
  font-weight: bold;
}
</style>
