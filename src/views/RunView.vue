<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { NavigationGuardNext, RouteLocationNormalized } from 'vue-router'
import { useRunStore } from '@/stores/run'
import { useFilesStore } from '@/stores/files'
import { ImportState } from '@/importer/stateMachine'
import { ImportEngine } from '@/importer/engine'
import { Button, Progress, Card, Table } from '@/ui'

const { t } = useI18n()

const router = useRouter()
const run = useRunStore()
const filesStore = useFilesStore()

// Throughput display - updated periodically
const throughputDisplay = ref('-- rows/sec')
let throughputInterval: ReturnType<typeof setInterval> | null = null

const stateLabel = computed(() => {
  const labels: Record<ImportState, string> = {
    [ImportState.IDLE]: t('run.state.idle'),
    [ImportState.VALIDATING]: t('run.state.validating'),
    [ImportState.RUNNING_FILE]: t('run.state.running'),
    [ImportState.RUNNING_BATCH]: t('run.state.batch'),
    [ImportState.RETRYING]: t('run.state.retrying'),
    [ImportState.PAUSED]: t('run.state.paused'),
    [ImportState.COMPLETED]: t('run.state.completed'),
    [ImportState.FAILED]: t('run.state.failed')
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

function updateThroughput() {
  if (run.engine && run.isActive) {
    throughputDisplay.value = run.engine.getThroughput().display
  }
}

onMounted(async () => {
  // Start throughput update interval
  throughputInterval = setInterval(updateThroughput, 500)

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

onUnmounted(() => {
  if (throughputInterval) {
    clearInterval(throughputInterval)
    throughputInterval = null
  }
})

// Warn before leaving during active import
onBeforeRouteLeave(
  (_to: RouteLocationNormalized, _from: RouteLocationNormalized, next: NavigationGuardNext) => {
    if (run.isActive) {
      const confirmed = window.confirm(t('run.leaveWarning'))
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
  // Show results instead of going back to files
  router.push('/results')
}

function handleSkipFile() {
  run.engine?.skipCurrentFile()
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
              {{ $t('run.dryRun') }}
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
            {{ throughputDisplay }}
          </div>
          <div class="csv-text-sm csv-text-muted">
            {{ $t('run.eta') }}: {{ etaDisplay }}
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
          {{ $t('run.resume') }}
        </Button>
        <Button
          v-else-if="isRunning"
          variant="outline"
          @click="handlePause"
        >
          {{ $t('run.pause') }}
        </Button>
        <Button
          v-if="isRunning"
          variant="outline"
          @click="handleSkipFile"
        >
          {{ $t('run.skipFile') }}
        </Button>
        <Button
          v-if="isRunning || run.state === ImportState.PAUSED"
          variant="destructive"
          @click="handleAbort"
        >
          {{ $t('run.abort') }}
        </Button>
        <Button
          v-if="run.state === ImportState.COMPLETED || run.state === ImportState.FAILED"
          @click="viewResults"
        >
          {{ $t('run.viewResults') }}
        </Button>
      </div>
    </Card>

    <!-- Per-File Progress -->
    <Card class="csv-p-4">
      <h3 class="csv-font-semibold csv-mb-4">{{ $t('run.filesTable.title') }}</h3>

      <Table>
        <thead>
          <tr>
            <th class="csv-text-left">{{ $t('run.filesTable.file') }}</th>
            <th class="csv-text-right">{{ $t('run.filesTable.progress') }}</th>
            <th class="csv-text-right">{{ $t('run.filesTable.success') }}</th>
            <th class="csv-text-right">{{ $t('run.filesTable.failed') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="file in fileProgressList"
            :key="file.filename"
            :class="{
              'csv-bg-blue-50': run.currentFile?.filename === file.filename,
              'csv-bg-gray-100 csv-opacity-60': file.skipped
            }"
          >
            <td>
              {{ file.filename }}
              <span v-if="file.skipped" class="csv-skipped-badge">{{ $t('run.skipped') }}</span>
            </td>
            <td class="csv-text-right">
              <span v-if="file.skipped">--</span>
              <span v-else>{{ formatNumber(file.processedRows) }} / {{ formatNumber(file.totalRows) }}</span>
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
        {{ $t('run.recentErrors') }} ({{ run.errors.length }})
      </h3>

      <div class="csv-max-h-48 csv-overflow-y-auto csv-space-y-2">
        <div
          v-for="(error, idx) in run.errors.slice(-10).reverse()"
          :key="idx"
          class="csv-p-2 csv-bg-red-50 csv-rounded csv-text-sm"
        >
          <div class="csv-font-medium">
            {{ error.filename }} - {{ $t('run.row') }} {{ error.rowNumber }}
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
.csv-skipped-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.125rem 0.375rem;
  font-size: 0.625rem;
  font-weight: 600;
  color: #6b7280;
  background: #e5e7eb;
  border-radius: 0.25rem;
  text-transform: uppercase;
}
</style>
