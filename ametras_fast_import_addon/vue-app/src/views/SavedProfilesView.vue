<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProfilesStore } from '@/stores/profiles'
import { useSessionStore } from '@/stores/session'
import { usePlatformStore } from '@/stores/platform'
import { useProfileImport } from '@/composables/useProfileImport'
import { exportProfileClean } from '@/api/profileApi'
import { checkOdooCompatibility } from '@/utils/profileUtils'
import { formatTimestamp } from '@/utils/formatters'
import { showAlert, showConfirm } from '@/composables/useDialog'
import { createRunConfig } from '@/types/runConfig'
import type { ImportProfile } from '@/types/importProfile'
import { Button, Card } from '@/ui'
import ProfileEditor from '@/components/ProfileEditor.vue'
import { importStandaloneProfile } from '@/services/standaloneProfiles'
import { exportProfileToZip, downloadBlob } from '@/utils/profileUtils'
import { generateProfileCSV, generateMappingsCSV, generateSequenceCSV, generateFieldMappingsCSV, generateRunSettingsCSV } from '@/services/profileExporter'

const { t } = useI18n()

const profiles = useProfilesStore()
const session = useSessionStore()
const platform = usePlatformStore()
const { importing, error: importError, importProfile } = useProfileImport()

const importingLocal = ref(false)
const localImportError = ref<string | null>(null)

// Track expanded profile and its full data
const expandedProfileId = ref<number | null>(null)
const expandedProfile = ref<ImportProfile | null>(null)
const loadingProfileId = ref<number | null>(null)

// Single-profile mode: when opened from Odoo tree view, show only that profile
const singleProfileId = ref<number | null>(null)

const displayedProfiles = computed(() => {
  if (singleProfileId.value !== null) {
    return profiles.profileList.filter(p => p.id === singleProfileId.value)
  }
  return profiles.profileList
})

onMounted(async () => {
  await profiles.loadProfiles()
  // Auto-expand profile when navigated from Odoo tree view
  if (session.expandProfileId) {
    const targetId = session.expandProfileId
    session.setExpandProfileId(null)
    singleProfileId.value = targetId
    await toggleProfileExpand(targetId)
  }
})

async function handleImportProfile() {
  const result = await importProfile()
  if (result) {
    profiles.invalidateCache()
    await profiles.loadProfiles(true)
  }
}

async function handleImportLocalProfile() {
  localImportError.value = null

  // Create file input and trigger click
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.zip'

  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return

    importingLocal.value = true
    try {
      const profile = await importStandaloneProfile(file)
      profiles.cacheProfile(profile)
      await profiles.loadLocalProfiles()
    } catch (e) {
      localImportError.value = t('profiles.importFailed', { error: e instanceof Error ? e.message : String(e) })
    } finally {
      importingLocal.value = false
    }
  }

  input.click()
}

async function handleExportLocalProfile(profile: ImportProfile, event: Event) {
  event.stopPropagation()
  try {
    const csvFiles: Record<string, string> = {
      'profile.csv': generateProfileCSV(profile),
      'mappings.csv': generateMappingsCSV(profile.mappings),
      'sequence.csv': generateSequenceCSV(profile.sequence),
      'run_settings.csv': generateRunSettingsCSV(profile.runSettings)
    }
    if (profile.richFieldMappings?.length) {
      csvFiles['field_mappings.csv'] = generateFieldMappingsCSV(profile.richFieldMappings)
    }
    const blob = await exportProfileToZip(csvFiles, profile.name)
    downloadBlob(blob, `${profile.name}.zip`)
  } catch (e) {
    showAlert(t('profiles.failedToExport', { error: (e as Error).message }))
  }
}

async function handlePushToServer(profile: ImportProfile, event: Event) {
  event.stopPropagation()
  try {
    const serverProfile = await profiles.pushToServer(profile.id)
    // If expanded profile was pushed, update the reference
    if (expandedProfileId.value === profile.id) {
      expandedProfileId.value = serverProfile.id
      expandedProfile.value = serverProfile
    }
    showAlert(t('profiles.pushedToServer', { name: profile.name }))
  } catch (e) {
    showAlert(t('profiles.failedToPush', { error: (e as Error).message }))
  }
}

async function handleExportProfile(profileId: number, name: string, event: Event) {
  event.stopPropagation()
  try {
    await exportProfileClean(profileId, name)
  } catch (e) {
    showAlert(t('profiles.failedToExport', { error: (e as Error).message }))
  }
}

async function handleDeleteProfile(id: number, name: string, event: Event) {
  event.stopPropagation()
  const ok = await showConfirm(t('profiles.deleteConfirm', { name }))
  if (ok) {
    try {
      await profiles.deleteProfile(id)
      // Close expanded view if this profile was expanded
      if (expandedProfileId.value === id) {
        expandedProfileId.value = null
        expandedProfile.value = null
      }
    } catch (e) {
      showAlert(t('profiles.failedToDelete', { error: (e as Error).message }))
    }
  }
}

function getCompatibility(profile: { odooMinVersion?: string }) {
  return checkOdooCompatibility(
    profile as Parameters<typeof checkOdooCompatibility>[0],
    session.serverVersion
  )
}

async function toggleProfileExpand(profileId: number) {
  if (expandedProfileId.value === profileId) {
    // Collapse
    expandedProfileId.value = null
    expandedProfile.value = null
    return
  }

  // Load full profile data
  loadingProfileId.value = profileId
  try {
    const fullProfile = await profiles.loadProfile(profileId)
    expandedProfile.value = fullProfile
    expandedProfileId.value = profileId
  } catch (e) {
    showAlert(t('profiles.failedToLoad', { error: (e as Error).message }))
  } finally {
    loadingProfileId.value = null
  }
}

// Create a dummy RunConfig for viewing (no overrides)
function createViewRunConfig(profileId: number) {
  return createRunConfig(profileId)
}
</script>

<template>
  <div class="p-4 d-flex flex-column gap-3">
    <!-- Header -->
    <div class="d-flex justify-content-between align-items-center">
      <h1 class="fs-4 fw-semibold mb-0">{{ $t('profiles.title') }}</h1>
      <div class="d-flex gap-2 align-items-center">
        <small
          v-if="importError || localImportError"
          class="text-danger"
        >
          {{ importError || localImportError }}
        </small>
        <!-- Server profile import (hidden in standalone mode) -->
        <Button
          v-if="platform.capabilities.serverProfiles"
          variant="outline"
          size="sm"
          :disabled="importing"
          @click="handleImportProfile"
        >
          {{ importing ? $t('profiles.uploading') : $t('profiles.uploadZip') }}
        </Button>
        <!-- Local profile import (always available) -->
        <Button
          variant="outline"
          size="sm"
          :disabled="importingLocal"
          @click="handleImportLocalProfile"
        >
          {{ importingLocal ? $t('profiles.uploading') : $t('profiles.uploadLocalZip') }}
        </Button>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="profiles.loading" class="text-center py-5 text-body-secondary small">
      {{ $t('profiles.loading') }}
    </div>

    <!-- Empty state -->
    <div v-else-if="profiles.profileList.length === 0" class="text-center py-5 text-body-secondary small">
      {{ $t('profiles.noProfiles') }}
    </div>

    <!-- Profile list -->
    <div v-else class="d-flex flex-column gap-3">
      <Card
        v-for="profile in displayedProfiles"
        :key="profile.id"
        class="csv-profile-card"
        :class="{ 'csv-profile-card--expanded': expandedProfileId === profile.id }"
      >
        <!-- Profile header (clickable to expand) -->
        <div
          class="csv-profile-card__header"
          @click="toggleProfileExpand(profile.id)"
        >
          <div class="csv-profile-card__info">
            <div class="fw-medium small d-flex align-items-center gap-2">
              <span class="csv-profile-card__expand-icon">
                {{ expandedProfileId === profile.id ? '▼' : '▶' }}
              </span>
              {{ profile.name }}
              <span
                v-if="profile.isStandalone && profile.id < 0"
                class="badge rounded-pill csv-compat-badge--local"
              >
                {{ $t('profiles.local') }}
              </span>
              <span
                v-else-if="profile.isStandalone && profile.id > 0"
                class="badge rounded-pill csv-compat-badge--server"
              >
                {{ $t('profiles.server') }}
              </span>
              <span
                v-if="!getCompatibility(profile).compatible"
                class="badge rounded-pill csv-compat-badge--incompatible"
                :title="getCompatibility(profile).reason"
              >
                {{ $t('profiles.incompatible') }}
              </span>
              <span
                v-else-if="profile.odooMinVersion"
                class="badge rounded-pill csv-compat-badge--compatible"
              >
                v{{ profile.odooMinVersion }}+
              </span>
            </div>
            <div v-if="profile.description" class="text-body-secondary ms-4" style="font-size: 0.75rem;">
              {{ profile.description }}
            </div>
            <div class="text-body-secondary mt-1 ms-4" style="font-size: 0.75rem;">
              v{{ profile.version }} &middot; {{ $t('profiles.updated') }}: {{ formatTimestamp(profile.updatedAt) }}
            </div>
          </div>

          <div class="d-flex gap-1" @click.stop>
            <Button
              v-if="profile.isStandalone && profile.id < 0"
              variant="outline"
              size="sm"
              @click="handlePushToServer(profile, $event)"
            >
              {{ $t('profiles.pushToServer') }}
            </Button>
            <Button
              v-if="profile.isStandalone"
              variant="outline"
              size="sm"
              @click="handleExportLocalProfile(profile, $event)"
            >
              {{ $t('profiles.exportZip') }}
            </Button>
            <Button
              v-else
              variant="outline"
              size="sm"
              @click="handleExportProfile(profile.id, profile.name, $event)"
            >
              {{ $t('profiles.exportZip') }}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              @click="handleDeleteProfile(profile.id, profile.name, $event)"
            >
              {{ $t('profiles.delete') }}
            </Button>
          </div>
        </div>

        <!-- Loading indicator -->
        <div
          v-if="loadingProfileId === profile.id"
          class="csv-profile-card__loading"
        >
          {{ $t('common.loading') }}
        </div>

        <!-- Expanded profile details -->
        <div
          v-else-if="expandedProfileId === profile.id && expandedProfile"
          class="csv-profile-card__details"
        >
          <ProfileEditor
            :profile="expandedProfile"
            :run-config="createViewRunConfig(expandedProfile.id)"
            :effective-run-settings="expandedProfile.runSettings"
            :effective-mappings="expandedProfile.mappings"
            :effective-sequence="expandedProfile.sequence"
            :has-overrides="false"
          />
        </div>
      </Card>
    </div>
  </div>
</template>

<style scoped>
.csv-profile-card {
  overflow: hidden;
}

.csv-profile-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 0.75rem;
  cursor: pointer;
  transition: background-color 0.15s;
}

.csv-profile-card__header:hover {
  background-color: var(--bs-tertiary-bg);
}

.csv-profile-card--expanded .csv-profile-card__header {
  border-bottom: 1px solid var(--bs-border-color);
}

.csv-profile-card__info {
  flex: 1;
  min-width: 0;
}

.csv-profile-card__expand-icon {
  display: inline-block;
  width: 1rem;
  font-size: 0.625rem;
  color: var(--bs-secondary-color);
}

.csv-profile-card__loading {
  padding: 1rem;
  text-align: center;
  color: var(--bs-secondary-color);
  font-size: 0.875rem;
}

.csv-profile-card__details {
  padding: 0;
  background: var(--bs-tertiary-bg);
}

.csv-profile-card__details :deep(.csv-profile-editor) {
  border: none;
  border-radius: 0;
}

.csv-compat-badge--compatible {
  background: var(--bs-success-bg-subtle);
  color: var(--bs-success-text-emphasis);
  font-size: 0.625rem;
  font-weight: 500;
}

.csv-compat-badge--incompatible {
  background: var(--bs-danger-bg-subtle);
  color: var(--bs-danger-text-emphasis);
  font-size: 0.625rem;
  font-weight: 500;
}

.csv-compat-badge--local {
  background: var(--bs-info-bg-subtle);
  color: var(--bs-info-text-emphasis);
  font-size: 0.625rem;
  font-weight: 500;
}

.csv-compat-badge--server {
  background: var(--bs-success-bg-subtle);
  color: var(--bs-success-text-emphasis);
  font-size: 0.625rem;
  font-weight: 500;
}
</style>
