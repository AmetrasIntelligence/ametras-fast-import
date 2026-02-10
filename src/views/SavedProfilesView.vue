<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProfilesStore } from '@/stores/profiles'
import { useSessionStore } from '@/stores/session'
import { useProfileImport } from '@/composables/useProfileImport'
import { exportProfileClean } from '@/api/profileApi'
import { checkOdooCompatibility } from '@/utils/profileVersioning'
import { formatTimestamp } from '@/utils/formatters'
import { showAlert, showConfirm } from '@/composables/useDialog'
import { createRunConfig } from '@/types/runConfig'
import type { ImportProfile } from '@/types/importProfile'
import { Button, Card } from '@/ui'
import ProfileEditor from '@/components/ProfileEditor.vue'

const { t } = useI18n()

const profiles = useProfilesStore()
const session = useSessionStore()
const { importing, error: importError, importProfile } = useProfileImport()

// Track expanded profile and its full data
const expandedProfileId = ref<number | null>(null)
const expandedProfile = ref<ImportProfile | null>(null)
const loadingProfileId = ref<number | null>(null)

onMounted(() => {
  profiles.loadProfiles()
})

async function handleImportProfile() {
  const result = await importProfile()
  if (result) {
    profiles.invalidateCache()
    await profiles.loadProfiles(true)
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
  <div class="csv-p-6 csv-space-y-4">
    <!-- Header -->
    <div class="csv-flex csv-justify-between csv-items-center">
      <h1 class="csv-text-2xl csv-font-semibold">{{ $t('profiles.title') }}</h1>
      <div class="csv-flex csv-gap-2 csv-items-center">
        <span
          v-if="importError"
          class="csv-text-xs csv-text-red-600"
        >
          {{ importError }}
        </span>
        <Button
          variant="outline"
          size="sm"
          :disabled="importing"
          @click="handleImportProfile"
        >
          {{ importing ? $t('profiles.uploading') : $t('profiles.uploadZip') }}
        </Button>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="profiles.loading" class="csv-text-center csv-py-8 csv-text-muted csv-text-sm">
      {{ $t('profiles.loading') }}
    </div>

    <!-- Empty state -->
    <div v-else-if="profiles.profileList.length === 0" class="csv-text-center csv-py-8 csv-text-muted csv-text-sm">
      {{ $t('profiles.noProfiles') }}
    </div>

    <!-- Profile list -->
    <div v-else class="csv-space-y-3">
      <Card
        v-for="profile in profiles.profileList"
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
            <div class="csv-font-medium csv-text-sm csv-flex csv-items-center csv-gap-2">
              <span class="csv-profile-card__expand-icon">
                {{ expandedProfileId === profile.id ? '▼' : '▶' }}
              </span>
              {{ profile.name }}
              <span
                v-if="!getCompatibility(profile).compatible"
                class="csv-compat-badge csv-compat-badge--incompatible"
                :title="getCompatibility(profile).reason"
              >
                {{ $t('profiles.incompatible') }}
              </span>
              <span
                v-else-if="profile.odooMinVersion"
                class="csv-compat-badge csv-compat-badge--compatible"
              >
                v{{ profile.odooMinVersion }}+
              </span>
            </div>
            <div v-if="profile.description" class="csv-text-xs csv-text-muted csv-ml-5">
              {{ profile.description }}
            </div>
            <div class="csv-text-xs csv-text-muted csv-mt-1 csv-ml-5">
              v{{ profile.version }} &middot; {{ $t('profiles.updated') }}: {{ formatTimestamp(profile.updatedAt) }}
            </div>
          </div>

          <div class="csv-flex csv-gap-1" @click.stop>
            <Button
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
.csv-text-red-600 {
  color: #dc2626;
}

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
  background-color: #f9fafb;
}

.csv-profile-card--expanded .csv-profile-card__header {
  border-bottom: 1px solid #e5e7eb;
}

.csv-profile-card__info {
  flex: 1;
  min-width: 0;
}

.csv-profile-card__expand-icon {
  display: inline-block;
  width: 1rem;
  font-size: 0.625rem;
  color: #6b7280;
}

.csv-profile-card__loading {
  padding: 1rem;
  text-align: center;
  color: #6b7280;
  font-size: 0.875rem;
}

.csv-profile-card__details {
  padding: 0;
  background: #f9fafb;
}

.csv-profile-card__details :deep(.csv-profile-editor) {
  border: none;
  border-radius: 0;
}

.csv-compat-badge {
  display: inline-block;
  padding: 0.125rem 0.375rem;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-weight: 500;
  line-height: 1.25;
}

.csv-compat-badge--compatible {
  background: #dcfce7;
  color: #166534;
}

.csv-compat-badge--incompatible {
  background: #fef2f2;
  color: #991b1b;
}
</style>
