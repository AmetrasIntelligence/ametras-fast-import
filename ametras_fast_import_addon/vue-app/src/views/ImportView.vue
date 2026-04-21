<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/files'
import { useConfigStore } from '@/stores/config'
import { useProfilesStore } from '@/stores/profiles'
import { useRunStore } from '@/stores/run'
import { showConfirm } from '@/composables/useDialog'
import { useFieldMetadata } from '@/composables/useFieldMetadata'
import { useFileManagement } from '@/composables/useFileManagement'
import { useProfileWorkflow } from '@/composables/useProfileWorkflow'
import { Button, Card } from '@/ui'
import FileDropZone from '@/components/FileDropZone.vue'
import ModelSelect from '@/components/ModelSelect.vue'
import ModelSuggestion from '@/components/ModelSuggestion.vue'
import ImportSettings from '@/components/ImportSettings.vue'
import FieldMappingTable from '@/components/FieldMappingTable.vue'
import FileList, { type FileListItem } from '@/components/FileList.vue'
import ProfileSelect from '@/components/ProfileSelect.vue'
import { ref } from 'vue'

const { t } = useI18n()
const router = useRouter()
const filesStore = useFilesStore()
const config = useConfigStore()
const profiles = useProfilesStore()
const run = useRunStore()

// Composables
const fieldMetadata = useFieldMetadata()
const fileManagement = useFileManagement(fieldMetadata)
const profileWorkflow = useProfileWorkflow(fieldMetadata)

const configTab = ref<'profile' | 'settings'>('profile')

// Files list for FileList component (sorted by import sequence)
const fileListItems = computed<FileListItem[]>(() => {
  const seq = config.importSequence
  return filesStore.files
    .slice()
    .sort((a, b) => {
      const ai = seq.indexOf(a.name)
      const bi = seq.indexOf(b.name)
      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi)
    })
    .map(f => {
      const analysis = filesStore.getAnalysis(f.id)
      return {
        ...f,
        rowCount: analysis?.rowCount,
        headers: analysis?.headers,
        sampleRows: analysis?.sampleRows
      }
    })
})

const hasFiles = computed(() => filesStore.files.length > 0)

// Navigation guard: warn when leaving with unsaved changes
onBeforeRouteLeave(async () => {
  if (profileWorkflow.hasUnsavedChanges.value) {
    const confirmed = await showConfirm(t('config.unsavedChangesWarning'))
    if (!confirmed) return false
  }
  return true
})

onMounted(async () => {
  await fileManagement.loadInitialData()

  // Load server profiles
  await profiles.loadProfiles()

  // Restore active profile from config store (persists across navigation)
  if (config.activeProfileId && !profileWorkflow.activeProfile.value) {
    try {
      await profileWorkflow.handleProfileSelect(config.activeProfileId)
    } catch {
      config.setActiveProfileId(null)
    }
  }

  // Restore existing files (suggestions, field caches)
  await fileManagement.restoreExistingFiles()
})

async function proceed() {
  if (fileManagement.hasPartialMappings.value) {
    const partialFiles = filesStore.files
      .filter(f => fileManagement.getFileStatus(f.name) === 'partial')
      .map(f => f.name)
    const ok = await showConfirm(t('config.unmappedFieldsWarning', { count: partialFiles.length, files: partialFiles.join(', ') }))
    if (!ok) return
  }
  run.reset()
  router.push('/run')
}
</script>

<template>
  <div class="p-4 d-flex flex-column gap-4">
    <div class="d-flex justify-content-between align-items-center">
      <h1 class="fs-4 fw-semibold mb-0">{{ $t('nav.import') }}</h1>
      <div v-if="hasFiles" class="d-flex gap-2 align-items-center">
        <small v-if="profileWorkflow.activeProfile.value" :class="profileWorkflow.hasUnsavedChanges.value ? 'text-warning' : 'text-body-secondary'">
          {{ profileWorkflow.activeProfile.value.name }} v{{ profileWorkflow.activeProfile.value.version }}
          <span v-if="profileWorkflow.hasUnsavedChanges.value" class="csv-edited-badge">{{ $t('config.edited') }}</span>
        </small>
        <Button
          v-if="profileWorkflow.activeProfile.value"
          variant="outline"
          size="sm"
          @click="profileWorkflow.updateExistingProfile"
        >
          {{ $t('config.updateProfile') }}
        </Button>
        <Button variant="outline" size="sm" @click="profileWorkflow.saveAsProfile">
          {{ $t('config.saveAsProfile') }}
        </Button>
      </div>
    </div>

    <div v-if="fileManagement.loadError.value" class="alert alert-danger py-2 small mb-0">
      {{ fileManagement.loadError.value }}
    </div>

    <!-- Show drop zone only when no files yet -->
    <FileDropZone
      v-if="!hasFiles"
      @files-dropped="fileManagement.handleDrop"
      @browse="fileManagement.selectFiles"
    />

    <!-- Show config sections only when files are selected -->
    <template v-if="hasFiles">
      <!-- Profile & Settings Section -->
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="small fw-semibold">{{ $t('config.serverProfile') }}</span>
      </div>
      <Card class="csv-import-card">
        <div class="csv-import-card__tabs">
          <button
            type="button"
            class="csv-import-card__tab"
            :class="{ 'csv-import-card__tab--active': configTab === 'profile' }"
            @click="configTab = 'profile'"
          >
            {{ $t('config.tabs.profile') }}
          </button>
          <button
            type="button"
            class="csv-import-card__tab"
            :class="{ 'csv-import-card__tab--active': configTab === 'settings' }"
            @click="configTab = 'settings'"
          >
            {{ $t('config.tabs.settings') }}
          </button>
        </div>
        <div v-show="configTab === 'profile'" class="csv-import-card__content">
          <ProfileSelect
            :model-value="profileWorkflow.activeProfile.value?.id ?? null"
            :profiles="profiles.profileList"
            :loading="profiles.loading"
            @update:model-value="profileWorkflow.handleProfileSelect($event ?? 0)"
          />
          <div v-if="profileWorkflow.profileLoading.value" class="small text-body-secondary mt-2">{{ $t('config.loadingProfileData') }}</div>
        </div>
        <div v-show="configTab === 'settings'" class="csv-import-card__content">
          <ImportSettings />
        </div>
      </Card>

      <!-- Draggable File List -->
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="small fw-semibold">{{ $t('config.fileListTitle') }}</span>
        <div class="d-flex align-items-center gap-2">
          <small class="text-body-secondary">{{ fileListItems.length }} {{ $t('common.files', fileListItems.length) }}</small>
          <Button variant="ghost" size="sm" @click="fileManagement.removeAllFiles">
            {{ $t('files.removeAll') }}
          </Button>
        </div>
      </div>

      <FileList
        :files="fileListItems"
        :missing-files="[...profileWorkflow.profileMissingFiles.value]"
        @reorder="fileManagement.handleReorder"
        @remove="fileManagement.removeFile"
        @dismiss-missing="profileWorkflow.profileMissingFiles.value.delete($event)"
      >
        <template #expanded="{ file }">
          <div class="d-flex flex-column gap-3">
            <!-- 1. CSV Preview -->
            <div v-if="file.headers?.length" class="csv-config-section">
              <div class="csv-config-section__header">
                <span>{{ $t('config.csvPreview') }}</span>
                <small class="text-body-secondary">
                  {{ file.headers.length }} {{ $t('common.columns', file.headers.length) }} · {{ file.rowCount?.toLocaleString() || '?' }} {{ $t('common.rows', 2) }}
                </small>
              </div>
              <div class="csv-preview__scroll">
                <table class="csv-preview__table">
                  <thead>
                    <tr>
                      <th v-for="h in file.headers" :key="h">{{ h }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, idx) in (file.sampleRows || []).slice(0, 4)" :key="idx">
                      <td v-for="h in file.headers" :key="h">{{ row[h] ?? '' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 2. Model Selection -->
            <div class="csv-config-section">
              <div class="csv-config-section__header">
                <span>{{ $t('config.targetModel') }}</span>
              </div>

              <ModelSuggestion
                v-if="fileManagement.modelSuggestions.value.get(file.name) && !config.getFileMapping(file.name)?.model"
                :suggestion="fileManagement.modelSuggestions.value.get(file.name) ?? null"
                :current-model="config.getFileMapping(file.name)?.model || null"
                @accept="fileManagement.selectModelForFile(file.name, $event)"
              />

              <ModelSelect
                :model-value="config.getFileMapping(file.name)?.model || null"
                @update:model-value="fileManagement.selectModelForFile(file.name, $event)"
              />
            </div>

            <!-- 3. Field Mappings -->
            <FieldMappingTable
              v-if="config.getFileMapping(file.name)?.model && file.headers?.length"
              :headers="file.headers"
              :field-mappings="config.getFileMapping(file.name)?.fieldMappings || {}"
              :fields="fieldMetadata.getFieldsForFile(file.name)"
              :strict="config.getFileMapping(file.name)?.strict ?? true"
              :get-field-lookup="() => fieldMetadata.getFieldLookup(file.name)"
              :get-field-metadata="(csvHeader: string, odooField: string) => fieldMetadata.computeFieldMetadata(file.name, csvHeader, odooField)"
              @update:field-mapping="(header: string, field: string) => fieldMetadata.updateFieldMapping(file.name, header, field)"
              @update:transform="(header: string, transform: any) => fieldMetadata.updateTransform(file.name, header, transform)"
              @update:strict="fileManagement.toggleStrictForFile(file.name, $event)"
            />

            <!-- 4. Validate Button -->
            <div v-if="config.getFileMapping(file.name)?.model && Object.keys(config.getFileMapping(file.name)?.fieldMappings || {}).length > 0" class="csv-config-section">
              <Button
                variant="outline"
                size="sm"
                :disabled="fileManagement.validatingFile.value === file.name"
                @click="fileManagement.validateRowForFile(file.name)"
              >
                {{ fileManagement.validatingFile.value === file.name ? $t('config.validating') : $t('config.validateRow') }}
              </Button>

              <div
                v-if="fileManagement.getValidationResult(file.name)"
                class="csv-validation-result"
                :class="fileManagement.getValidationResult(file.name)!.ok ? 'csv-validation-result--ok' : 'csv-validation-result--error'"
              >
                <div class="csv-validation-result__header">
                  {{ fileManagement.getValidationResult(file.name)!.ok ? '✓ ' + $t('config.validationPassed') : '✗ ' + $t('config.validationFailed') }}
                </div>
                <div v-if="fileManagement.getValidationResult(file.name)!.message" class="csv-validation-result__message">
                  {{ fileManagement.getValidationResult(file.name)!.message }}
                </div>
                <div v-if="fileManagement.getValidationResult(file.name)!.data" class="csv-validation-result__data">
                  <pre>{{ JSON.stringify(fileManagement.getValidationResult(file.name)!.data, null, 2) }}</pre>
                </div>
              </div>
            </div>
          </div>
        </template>
      </FileList>

      <!-- Drop zone for adding more files (compact mode) -->
      <FileDropZone
        compact
        @files-dropped="fileManagement.handleDrop"
        @browse="fileManagement.selectFiles"
      />

      <div class="d-flex justify-content-end">
        <Button
          :disabled="!fileManagement.canStartImport.value"
          @click="proceed"
        >
          {{ $t('config.startImport') }}
        </Button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Edited indicator */
.csv-edited-badge {
  display: inline-block;
  margin-left: 0.25rem;
  padding: 0.125rem 0.375rem;
  font-size: 0.65rem;
  font-weight: 500;
  background: var(--bs-warning-bg-subtle);
  color: var(--bs-warning-text-emphasis);
  border-radius: var(--bs-border-radius-sm);
}

/* Import card with tabs (profile/settings) */
.csv-import-card {
  overflow: hidden;
}
.csv-import-card__tabs {
  display: flex;
  border-bottom: 1px solid var(--bs-border-color);
  background: var(--bs-tertiary-bg);
}
.csv-import-card__tab {
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
.csv-import-card__tab:hover {
  color: var(--bs-body-color);
  background: var(--bs-secondary-bg-subtle);
}
.csv-import-card__tab--active {
  color: var(--bs-primary);
  border-bottom-color: var(--bs-primary);
}
.csv-import-card__content {
  padding: 0.75rem;
}

/* Config sections inside expanded file area */
.csv-config-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.csv-config-section__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--bs-body-color);
}

/* CSV Preview */
.csv-preview__scroll {
  overflow-x: auto;
  max-width: 100%;
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
}
.csv-preview__table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 0.7rem;
  font-family: ui-monospace, monospace;
}
.csv-preview__table th {
  padding: 0.25rem 0.5rem;
  text-align: left;
  font-weight: 600;
  color: var(--bs-body-color);
  background: var(--bs-tertiary-bg);
  border-bottom: 1px solid var(--bs-border-color);
  white-space: nowrap;
}
.csv-preview__table td {
  padding: 0.2rem 0.5rem;
  color: var(--bs-secondary-color);
  border-bottom: 1px solid var(--bs-border-color-translucent);
  white-space: nowrap;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Validation result */
.csv-validation-result {
  margin-top: 0.5rem;
  padding: 0.5rem;
  border-radius: var(--bs-border-radius);
  font-size: 0.75rem;
}
.csv-validation-result--ok {
  background: var(--bs-success-bg-subtle);
  border: 1px solid var(--bs-success-border-subtle);
}
.csv-validation-result--error {
  background: var(--bs-danger-bg-subtle);
  border: 1px solid var(--bs-danger-border-subtle);
}
.csv-validation-result__header {
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.csv-validation-result--ok .csv-validation-result__header {
  color: var(--bs-success-text-emphasis);
}
.csv-validation-result--error .csv-validation-result__header {
  color: var(--bs-danger-text-emphasis);
}
.csv-validation-result__message {
  color: var(--bs-body-color);
  margin-bottom: 0.375rem;
}
.csv-validation-result__data {
  background: var(--bs-body-bg);
  border-radius: var(--bs-border-radius-sm);
  padding: 0.375rem;
  overflow-x: auto;
}
.csv-validation-result__data pre {
  margin: 0;
  font-size: 0.65rem;
  font-family: ui-monospace, monospace;
  color: var(--bs-secondary-color);
}
</style>
