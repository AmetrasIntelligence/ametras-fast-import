<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '@/stores/files'
import { useConfigStore } from '@/stores/config'
import { useProfilesStore } from '@/stores/profiles'
import { useSessionStore } from '@/stores/session'
import { checkOdooCompatibility } from '@/utils/profileVersioning'
import { formatTimestamp } from '@/utils/formatters'
import type { ImportProfile } from '@/types/importProfile'
import { Button, Card } from '@/ui'

const router = useRouter()
const filesStore = useFilesStore()
const config = useConfigStore()
const profiles = useProfilesStore()
const session = useSessionStore()

const selectedProfileId = ref<number | null>(null)
const loadingProfile = ref(false)
const validationErrors = ref<string[]>([])
const validationWarnings = ref<string[]>([])
const dryRun = ref(false)

const uploadedFilenames = computed(() => filesStore.files.map(f => f.name))

const selectedProfile = computed(() => {
  if (!selectedProfileId.value) return null
  return profiles.getProfile(selectedProfileId.value) || null
})

const compatibility = computed(() => {
  if (!selectedProfile.value) return { compatible: true }
  return checkOdooCompatibility(selectedProfile.value, session.serverVersion)
})

const isValid = computed(() => {
  return validationErrors.value.length === 0 && compatibility.value.compatible
})

const canRun = computed(() => {
  return selectedProfile.value && isValid.value && uploadedFilenames.value.length > 0
})

onMounted(async () => {
  await profiles.loadProfiles()
})

// Re-validate when profile or files change
watch([selectedProfileId, uploadedFilenames], async () => {
  if (!selectedProfileId.value) {
    validationErrors.value = []
    validationWarnings.value = []
    return
  }

  // Load full profile data if needed
  let profile = profiles.getProfile(selectedProfileId.value)
  if (!profile || profile.mappings.length === 0) {
    loadingProfile.value = true
    try {
      profile = await profiles.loadProfile(selectedProfileId.value)
    } finally {
      loadingProfile.value = false
    }
  }

  validateProfile(profile)
}, { immediate: true })

function validateProfile(profile: ImportProfile | null) {
  const errors: string[] = []
  const warnings: string[] = []

  if (!profile) {
    validationErrors.value = errors
    validationWarnings.value = warnings
    return
  }

  const uploaded = new Set(uploadedFilenames.value)
  const profileFiles = new Set(profile.mappings.map(m => m.filename))

  // Check for required files from profile that are missing
  for (const mapping of profile.mappings) {
    if (!uploaded.has(mapping.filename)) {
      errors.push(`Missing file: ${mapping.filename} (required for ${mapping.model})`)
    }
  }

  // Check for uploaded files not in profile
  for (const filename of uploadedFilenames.value) {
    if (!profileFiles.has(filename)) {
      warnings.push(`Extra file: ${filename} (not in profile, will be skipped)`)
    }
  }

  // Check sequence
  for (const seq of profile.sequence) {
    if (!uploaded.has(seq.filename)) {
      // Already covered by mappings check
    }
  }

  validationErrors.value = errors
  validationWarnings.value = warnings
}

async function selectProfile(profileId: number) {
  selectedProfileId.value = profileId
}

function applyProfileAndRun() {
  const profile = selectedProfile.value
  if (!profile) return

  // Apply profile settings to config store, with dry run override
  config.setSettings({ ...profile.runSettings, dryRun: dryRun.value })

  // Apply file mappings
  config.clearFileMappings()
  for (const mapping of profile.mappings) {
    // Build fieldMappings from profile's fieldMappings or richFieldMappings
    const fieldMappings: Record<string, string> = {}

    // Use simple fieldMappings if available
    if (profile.fieldMappings) {
      for (const fm of profile.fieldMappings) {
        if (fm.filename === mapping.filename) {
          fieldMappings[fm.csvColumn] = fm.odooField
        }
      }
    }

    // Use rich fieldMappings if available (takes precedence)
    if (profile.richFieldMappings) {
      for (const fm of profile.richFieldMappings) {
        if (fm.filename === mapping.filename) {
          fieldMappings[fm.csvHeader] = fm.odooField
        }
      }
    }

    config.setFileMapping(mapping.filename, {
      filename: mapping.filename,
      model: mapping.model,
      fieldMappings
    })
  }

  // Apply sequence
  const sequenceFilenames = profile.sequence
    .sort((a, b) => a.order - b.order)
    .map(s => s.filename)
    .filter(f => uploadedFilenames.value.includes(f))
  config.setSequence(sequenceFilenames)

  // Navigate to run
  router.push('/run')
}

function goBack() {
  router.push('/files')
}
</script>

<template>
  <div class="csv-p-6 csv-space-y-6">
    <div class="csv-flex csv-justify-between csv-items-center">
      <div>
        <h1 class="csv-text-2xl csv-font-semibold">Select Import Profile</h1>
        <p class="csv-text-sm csv-text-muted csv-mt-1">
          {{ uploadedFilenames.length }} file(s) uploaded
        </p>
      </div>
      <Button variant="outline" @click="goBack">
        Back to Files
      </Button>
    </div>

    <!-- Profile List -->
    <div v-if="profiles.loading" class="csv-text-center csv-py-8 csv-text-muted">
      Loading profiles...
    </div>

    <div v-else-if="profiles.profileList.length === 0" class="csv-text-center csv-py-8">
      <p class="csv-text-muted csv-mb-4">No profiles available.</p>
      <p class="csv-text-sm csv-text-muted">
        Upload a profile ZIP in the Profiles tab first.
      </p>
      <Button variant="outline" class="csv-mt-4" @click="router.push('/mappings')">
        Go to Profiles
      </Button>
    </div>

    <div v-else class="csv-space-y-2">
      <Card
        v-for="profile in profiles.profileList"
        :key="profile.id"
        class="csv-p-4 csv-profile-card"
        :class="{
          'csv-profile-card--selected': selectedProfileId === profile.id,
          'csv-profile-card--incompatible': !checkOdooCompatibility(profile, session.serverVersion).compatible
        }"
        @click="selectProfile(profile.id)"
      >
        <div class="csv-flex csv-justify-between csv-items-start">
          <div>
            <div class="csv-font-medium csv-flex csv-items-center csv-gap-2">
              <span
                v-if="selectedProfileId === profile.id"
                class="csv-check"
              >✓</span>
              {{ profile.name }}
              <span
                v-if="!checkOdooCompatibility(profile, session.serverVersion).compatible"
                class="csv-badge csv-badge--error"
              >
                incompatible
              </span>
            </div>
            <div v-if="profile.description" class="csv-text-sm csv-text-muted csv-mt-1">
              {{ profile.description }}
            </div>
            <div class="csv-text-xs csv-text-muted csv-mt-2">
              v{{ profile.version }} · Updated: {{ formatTimestamp(profile.updatedAt) }}
            </div>
          </div>
        </div>
      </Card>
    </div>

    <!-- Validation Results -->
    <Card v-if="selectedProfile" class="csv-p-4">
      <h3 class="csv-font-semibold csv-mb-3">Validation</h3>

      <div v-if="loadingProfile" class="csv-text-muted csv-text-sm">
        Loading profile details...
      </div>

      <div v-else>
        <!-- Errors -->
        <div v-if="validationErrors.length > 0" class="csv-space-y-1 csv-mb-3">
          <div
            v-for="(error, idx) in validationErrors"
            :key="'err-' + idx"
            class="csv-validation-item csv-validation-item--error"
          >
            <span class="csv-validation-icon">✕</span>
            {{ error }}
          </div>
        </div>

        <!-- Warnings -->
        <div v-if="validationWarnings.length > 0" class="csv-space-y-1 csv-mb-3">
          <div
            v-for="(warning, idx) in validationWarnings"
            :key="'warn-' + idx"
            class="csv-validation-item csv-validation-item--warning"
          >
            <span class="csv-validation-icon">!</span>
            {{ warning }}
          </div>
        </div>

        <!-- Compatibility -->
        <div v-if="!compatibility.compatible" class="csv-validation-item csv-validation-item--error">
          <span class="csv-validation-icon">✕</span>
          {{ compatibility.reason }}
        </div>

        <!-- Success -->
        <div
          v-if="isValid && validationWarnings.length === 0"
          class="csv-validation-item csv-validation-item--success"
        >
          <span class="csv-validation-icon">✓</span>
          All files match profile requirements
        </div>

        <div
          v-else-if="isValid"
          class="csv-validation-item csv-validation-item--success"
        >
          <span class="csv-validation-icon">✓</span>
          Profile can be applied (with warnings)
        </div>
      </div>
    </Card>

    <!-- Run Options -->
    <Card v-if="selectedProfile && isValid" class="csv-p-4">
      <div class="csv-flex csv-items-center csv-justify-between">
        <label class="csv-flex csv-items-center csv-gap-2 csv-cursor-pointer">
          <input
            v-model="dryRun"
            type="checkbox"
            class="csv-checkbox"
          />
          <span class="csv-text-sm">
            Dry Run
            <span class="csv-text-muted">(validate without making changes)</span>
          </span>
        </label>

        <Button
          :disabled="!canRun"
          @click="applyProfileAndRun"
        >
          {{ dryRun ? 'Start Dry Run' : 'Start Import' }}
        </Button>
      </div>
    </Card>
  </div>
</template>

<style scoped>
.csv-profile-card {
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.csv-profile-card:hover {
  border-color: #2563eb;
}
.csv-profile-card--selected {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}
.csv-profile-card--incompatible {
  opacity: 0.6;
}
.csv-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  background: #2563eb;
  color: white;
  border-radius: 50%;
  font-size: 0.75rem;
}
.csv-badge {
  display: inline-block;
  padding: 0.125rem 0.375rem;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-weight: 500;
}
.csv-badge--error {
  background: #fef2f2;
  color: #991b1b;
}
.csv-validation-item {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}
.csv-validation-item--error {
  background: #fef2f2;
  color: #991b1b;
}
.csv-validation-item--warning {
  background: #fffbeb;
  color: #92400e;
}
.csv-validation-item--success {
  background: #f0fdf4;
  color: #166534;
}
.csv-validation-icon {
  flex-shrink: 0;
  font-weight: 600;
}
.csv-checkbox {
  width: 1rem;
  height: 1rem;
  accent-color: #2563eb;
}
.csv-cursor-pointer {
  cursor: pointer;
}
</style>
