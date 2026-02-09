<script setup lang="ts">
import { onMounted } from 'vue'
import { useSavedMappingsStore, type SavedMapping } from '@/stores/savedMappings'
import { useProfilesStore } from '@/stores/profiles'
import { useSessionStore } from '@/stores/session'
import { useProfileImport } from '@/composables/useProfileImport'
import { exportProfileClean } from '@/api/profileApi'
import { checkOdooCompatibility } from '@/utils/profileVersioning'
import { downloadBlob } from '@/utils/profileZip'
import { getAllTemplates, getTemplate } from '@/utils/profileTemplates'
import { exportProfileToZip } from '@/utils/profileZip'
import { showAlert, showConfirm } from '@/composables/useDialog'
import { Button, Card } from '@/ui'

const savedMappings = useSavedMappingsStore()
const profiles = useProfilesStore()
const session = useSessionStore()
const { importing, error: importError, importProfile } = useProfileImport()
const templateList = getAllTemplates()

onMounted(() => {
  savedMappings.load()
  profiles.loadProfiles()
})

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString()
}

async function deleteMapping(mapping: SavedMapping) {
  const ok = await showConfirm(`Delete mapping for "${mapping.filenamePattern}"?`)
  if (ok) {
    savedMappings.deleteMapping(mapping.id)
  }
}

async function handleImportProfile() {
  const result = await importProfile()
  if (result) {
    // Refresh list
    profiles.invalidateCache()
    await profiles.loadProfiles(true)
  }
}

async function handleExportProfile(profileId: number, name: string) {
  try {
    await exportProfileClean(profileId, name)
  } catch (e) {
    showAlert(`Failed to export profile: ${(e as Error).message}`)
  }
}

async function handleDeleteProfile(id: number, name: string) {
  const ok = await showConfirm(`Delete profile "${name}"? This will remove it from the server.`)
  if (ok) {
    try {
      await profiles.deleteProfile(id)
    } catch (e) {
      showAlert(`Failed to delete profile: ${(e as Error).message}`)
    }
  }
}

function getCompatibility(profile: { odooMinVersion?: string }) {
  return checkOdooCompatibility(
    profile as Parameters<typeof checkOdooCompatibility>[0],
    session.serverVersion
  )
}

async function downloadTemplate(templateId: string) {
  try {
    const profile = getTemplate(templateId)
    const {
      exportProfileCSV,
      exportMappingsToCSV,
      exportSequenceToCSV,
      exportFieldMappingsToCSV
    } = await import('@/types/importProfile')

    const csvFiles: Record<string, string> = {
      'profile.csv': exportProfileCSV(profile),
      'mappings.csv': exportMappingsToCSV(profile.mappings),
      'sequence.csv': exportSequenceToCSV(profile.sequence)
    }

    const settingsLines = ['key,value']
    for (const [key, value] of Object.entries(profile.runSettings)) {
      settingsLines.push(`${key},${value}`)
    }
    csvFiles['run_settings.csv'] = settingsLines.join('\n')

    if (profile.fieldMappings && profile.fieldMappings.length > 0) {
      csvFiles['field_mappings.csv'] = exportFieldMappingsToCSV(profile.fieldMappings)
    }

    const blob = await exportProfileToZip(csvFiles, profile.name)
    const safeName = profile.name.replace(/[^a-zA-Z0-9_-]/g, '_')
    downloadBlob(blob, `${safeName}.zip`)
  } catch (e) {
    showAlert(`Failed to download template: ${(e as Error).message}`)
  }
}
</script>

<template>
  <div class="csv-p-6 csv-space-y-4">
    <div class="csv-flex csv-justify-between csv-items-center">
      <h2 class="csv-text-lg csv-font-semibold">Saved Mappings</h2>
      <span class="csv-text-sm csv-text-muted">
        {{ savedMappings.mappings.length }} saved
      </span>
    </div>

    <div v-if="savedMappings.mappings.length === 0" class="csv-text-center csv-py-8 csv-text-muted">
      No saved mappings yet. Mappings are saved automatically when you import.
    </div>

    <div v-else class="csv-space-y-2">
      <Card
        v-for="mapping in savedMappings.mappings"
        :key="mapping.id"
        class="csv-p-3 csv-flex csv-items-center csv-justify-between"
      >
        <div>
          <div class="csv-font-medium csv-text-sm">{{ mapping.filenamePattern }}</div>
          <div class="csv-text-xs csv-text-muted">
            &rarr; {{ mapping.model }}
          </div>
          <div class="csv-text-xs csv-text-muted csv-mt-1">
            Last used: {{ formatDate(mapping.lastUsedAt) }}
          </div>
        </div>

        <div class="csv-flex csv-gap-1">
          <Button
            variant="ghost"
            size="sm"
            @click="deleteMapping(mapping)"
          >
            Delete
          </Button>
        </div>
      </Card>
    </div>

    <!-- Profile Templates Section -->
    <div class="csv-mt-8">
      <h2 class="csv-text-lg csv-font-semibold csv-mb-4">Profile Templates</h2>
      <div class="csv-grid csv-grid-cols-2 csv-gap-4">
        <Card
          v-for="template in templateList"
          :key="template.id"
          class="csv-p-4 csv-template-card"
          @click="downloadTemplate(template.id)"
        >
          <div class="csv-font-medium csv-text-sm">{{ template.name }}</div>
          <div class="csv-text-xs csv-text-muted csv-mt-1">{{ template.description }}</div>
          <div class="csv-text-xs csv-text-blue-600 csv-mt-2">Download as ZIP</div>
        </Card>
      </div>
    </div>

    <!-- Import Profiles Section -->
    <div class="csv-mt-8">
      <div class="csv-flex csv-justify-between csv-items-center csv-mb-4">
        <h2 class="csv-text-lg csv-font-semibold">Import Profiles</h2>
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
            {{ importing ? 'Uploading...' : 'Upload Profile (ZIP)' }}
          </Button>
        </div>
      </div>

      <div v-if="profiles.loading" class="csv-text-center csv-py-4 csv-text-muted csv-text-sm">
        Loading profiles...
      </div>

      <div v-else-if="profiles.profileList.length === 0" class="csv-text-center csv-py-4 csv-text-muted csv-text-sm">
        No saved profiles. Upload a ZIP profile or save one from the config screen.
      </div>

      <div v-else class="csv-space-y-2">
        <Card
          v-for="profile in profiles.profileList"
          :key="profile.id"
          class="csv-p-3 csv-flex csv-items-center csv-justify-between"
        >
          <div>
            <div class="csv-font-medium csv-text-sm csv-flex csv-items-center csv-gap-2">
              {{ profile.name }}
              <span
                v-if="!getCompatibility(profile).compatible"
                class="csv-compat-badge csv-compat-badge--incompatible"
                :title="getCompatibility(profile).reason"
              >
                incompatible
              </span>
              <span
                v-else-if="profile.odooMinVersion"
                class="csv-compat-badge csv-compat-badge--compatible"
              >
                v{{ profile.odooMinVersion }}+
              </span>
            </div>
            <div v-if="profile.description" class="csv-text-xs csv-text-muted">
              {{ profile.description }}
            </div>
            <div class="csv-text-xs csv-text-muted csv-mt-1">
              v{{ profile.version }} &middot; Updated: {{ formatDate(profile.updatedAt) }}
            </div>
          </div>

          <div class="csv-flex csv-gap-1">
            <Button
              variant="outline"
              size="sm"
              @click="handleExportProfile(profile.id, profile.name)"
            >
              Export ZIP
            </Button>
            <Button
              variant="ghost"
              size="sm"
              @click="handleDeleteProfile(profile.id, profile.name)"
            >
              Delete
            </Button>
          </div>
        </Card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.csv-template-card {
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.csv-template-card:hover {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1);
}
.csv-text-red-600 {
  color: #dc2626;
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
