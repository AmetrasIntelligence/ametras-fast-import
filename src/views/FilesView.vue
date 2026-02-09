<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '@/stores/files'
import { useConfigStore } from '@/stores/config'
import { analyzeCSV } from '@/importer/csvParser'
import { Button } from '@/ui'
import FileDropZone from '@/components/FileDropZone.vue'
import FileList from '@/components/FileList.vue'

const router = useRouter()
const filesStore = useFilesStore()
const config = useConfigStore()

const files = computed(() => {
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

async function selectFiles() {
  const selected = await window.api.files.select()
  await addAndAnalyze(selected)
}

async function addAndAnalyze(selected: Array<{ id: string; name: string; size: number }>) {
  filesStore.addFiles(selected)

  for (const file of selected) {
    const analysis = await analyzeCSV(file.id)
    filesStore.setAnalysis(file.id, analysis)
  }

  config.setSequence(filesStore.files.map(f => f.name))
}

function handleDrop(_files: File[]) {
  // In Electron, dropped files need to go through IPC
  // For now, fall back to the file dialog
  selectFiles()
}

function removeFile(id: string) {
  filesStore.removeFile(id)
  config.setSequence(filesStore.files.map(f => f.name))
}

function handleReorder(filenames: string[]) {
  config.setSequence(filenames)
}

function proceed() {
  router.push('/config')
}
</script>

<template>
  <div class="csv-p-6 csv-space-y-6">
    <div class="csv-flex csv-justify-between csv-items-center">
      <h1 class="csv-text-2xl csv-font-semibold">Select CSV Files</h1>
      <Button v-if="files.length > 0" @click="selectFiles">
        Add Files
      </Button>
    </div>

    <!-- Drop zone when no files -->
    <FileDropZone
      v-if="files.length === 0"
      @files-dropped="handleDrop"
      @browse="selectFiles"
    />

    <!-- File list with drag-to-reorder -->
    <div v-else>
      <FileList
        :files="files"
        @reorder="handleReorder"
        @remove="removeFile"
      >
        <template #expanded="{ file }">
          <div v-if="file.headers && file.headers.length > 0" class="csv-preview">
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
            <div class="csv-text-xs csv-text-muted csv-mt-1">
              {{ file.headers.length }} columns &middot; {{ file.rowCount?.toLocaleString() || '?' }} rows
            </div>
          </div>
          <div v-else class="csv-text-sm csv-text-muted">
            No preview available
          </div>
        </template>
      </FileList>

      <div class="csv-mt-4">
        <FileDropZone
          @files-dropped="handleDrop"
          @browse="selectFiles"
        />
      </div>
    </div>

    <div v-if="files.length > 0" class="csv-flex csv-justify-end">
      <Button @click="proceed">
        Configure Mappings
      </Button>
    </div>
  </div>
</template>

<style scoped>
.csv-preview__scroll {
  overflow-x: auto;
  max-width: 100%;
}
.csv-preview__table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 0.75rem;
  font-family: monospace;
}
.csv-preview__table th {
  padding: 0.25rem 0.5rem;
  text-align: left;
  font-weight: 600;
  color: #374151;
  background: #f3f4f6;
  border: 1px solid #e5e7eb;
  white-space: nowrap;
}
.csv-preview__table td {
  padding: 0.25rem 0.5rem;
  color: #6b7280;
  border: 1px solid #e5e7eb;
  white-space: nowrap;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
