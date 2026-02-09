<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import type { NavigationGuardNext, RouteLocationNormalized } from 'vue-router'
import { useRunStore } from '@/stores/run'
import { useFilesStore } from '@/stores/files'
import { ImportState } from '@/importer/stateMachine'
import { ImportEngine } from '@/importer/engine'
import { Button, Progress, Card, Table } from '@/ui'

const router = useRouter()
const run = useRunStore()
const filesStore = useFilesStore()

const stateLabel = computed(() => {
  const labels: Record<ImportState, string> = {
    [ImportState.IDLE]: 'Ready',
    [ImportState.VALIDATING]: 'Validating...',
    [ImportState.RUNNING_FILE]: 'Importing...',
    [ImportState.RUNNING_BATCH]: 'Processing Batch...',
    [ImportState.RETRYING]: 'Retrying Failed Rows...',
    [ImportState.PAUSED]: 'Paused',
    [ImportState.COMPLETED]: 'Completed',
    [ImportState.FAILED]: 'Failed'
  }
  return labels[run.state]
})

const etaDisplay = computed(() => {
  const seconds = run.estimatedTimeRemaining
  if (!seconds) return '--'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}m ${secs}s`
})

const fileProgressList = computed(() =>
  Array.from(run.progress.files.values())
)

const isRunning = computed(() =>
  [ImportState.VALIDATING, ImportState.RUNNING_FILE, ImportState.RUNNING_BATCH, ImportState.RETRYING].includes(run.state)
)

onMounted(async () => {
  // If already running or completed, just show the current state
  if (run.isActive || run.isCompleted) {
    return
  }

  const files = filesStore.files.map(f => ({
    id: f.id,
    name: f.name
  }))

  if (files.length === 0) return

  try {
    const newEngine = new ImportEngine()
    run.setEngine(newEngine)
    await newEngine.start(files)
  } catch (e) {
    console.error('Import engine error:', e)
  }
})

// Warn before leaving during active import
onBeforeRouteLeave(
  (_to: RouteLocationNormalized, _from: RouteLocationNormalized, next: NavigationGuardNext) => {
    if (run.isActive) {
      const confirmed = window.confirm(
        'An import is in progress. Leaving this page will abort the import.\n\nAre you sure you want to leave?'
      )
      if (!confirmed) {
        next(false)
        return
      }
      // User confirmed, abort the import
      run.engine?.abort()
    }
    next()
  }
)

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function handlePause() {
  run.engine?.pause()
}

function handleResume() {
  run.engine?.resume()
}

function handleAbort() {
  run.engine?.abort()
  router.push('/files')
}

function viewResults() {
  router.push('/results')
}
</script>

<template>
  <div class="csv-p-6 csv-space-y-6">
    <!-- Global Progress -->
    <Card class="csv-p-4">
      <div class="csv-flex csv-justify-between csv-items-center csv-mb-4">
        <div>
          <div class="csv-flex csv-items-center csv-gap-2">
            <h2 class="csv-text-lg csv-font-semibold">{{ stateLabel }}</h2>
            <span
              v-if="run.isDryRun"
              class="csv-dry-run-badge"
            >
              Dry Run
            </span>
          </div>
          <p class="csv-text-sm csv-text-muted">
            {{ run.progress.completedFiles }} / {{ run.progress.totalFiles }} files
          </p>
        </div>
        <div class="csv-text-right">
          <div class="csv-text-2xl csv-font-bold">
            {{ Math.round(run.globalProgress * 100) }}%
          </div>
          <div class="csv-text-sm csv-text-muted">
            ETA: {{ etaDisplay }}
          </div>
        </div>
      </div>

      <Progress
        :value="run.globalProgress * 100"
        size="lg"
      />

      <div class="csv-flex csv-gap-4 csv-mt-4">
        <Button
          v-if="run.state === ImportState.PAUSED"
          @click="handleResume"
        >
          Resume
        </Button>
        <Button
          v-else-if="isRunning"
          variant="outline"
          @click="handlePause"
        >
          Pause
        </Button>
        <Button
          v-if="isRunning || run.state === ImportState.PAUSED"
          variant="destructive"
          @click="handleAbort"
        >
          Abort
        </Button>
        <Button
          v-if="run.state === ImportState.COMPLETED || run.state === ImportState.FAILED"
          @click="viewResults"
        >
          View Results
        </Button>
      </div>
    </Card>

    <!-- Per-File Progress -->
    <Card class="csv-p-4">
      <h3 class="csv-font-semibold csv-mb-4">Files</h3>

      <Table>
        <thead>
          <tr>
            <th class="csv-text-left">File</th>
            <th class="csv-text-right">Progress</th>
            <th class="csv-text-right">Success</th>
            <th class="csv-text-right">Failed</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="file in fileProgressList"
            :key="file.filename"
            :class="{
              'csv-bg-blue-50': run.currentFile?.filename === file.filename
            }"
          >
            <td>{{ file.filename }}</td>
            <td class="csv-text-right">
              {{ formatNumber(file.processedRows) }} / {{ formatNumber(file.totalRows) }}
            </td>
            <td class="csv-text-right csv-text-green-600">
              {{ formatNumber(file.successCount) }}
            </td>
            <td class="csv-text-right csv-text-red-600">
              {{ formatNumber(file.failedCount) }}
            </td>
          </tr>
        </tbody>
      </Table>
    </Card>

    <!-- Recent Errors -->
    <Card v-if="run.errors.length > 0" class="csv-p-4">
      <h3 class="csv-font-semibold csv-mb-4">
        Recent Errors ({{ run.errors.length }})
      </h3>

      <div class="csv-max-h-48 csv-overflow-y-auto csv-space-y-2">
        <div
          v-for="(error, idx) in run.errors.slice(-10).reverse()"
          :key="idx"
          class="csv-p-2 csv-bg-red-50 csv-rounded csv-text-sm"
        >
          <div class="csv-font-medium">
            {{ error.filename }} - Row {{ error.rowNumber }}
          </div>
          <div class="csv-text-red-700">{{ error.error }}</div>
        </div>
      </div>
    </Card>
  </div>
</template>

<style scoped>
.csv-dry-run-badge {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #fbbf24;
  border-radius: 9999px;
}
</style>
