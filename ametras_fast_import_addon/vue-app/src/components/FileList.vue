<script setup lang="ts">
import { ref, computed } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useRunStore } from '@/stores/run'
import { ImportState } from '@/importer/stateMachine'
import MappingStatus from './MappingStatus.vue'

export interface FileListItem {
  id: string
  name: string
  size: number
  rowCount?: number
  headers?: string[]
  sampleRows?: Record<string, string>[]
}

const props = defineProps<{
  files: FileListItem[]
}>()

const emit = defineEmits<{
  reorder: [filenames: string[]]
  remove: [fileId: string]
  expand: [fileId: string]
}>()

const config = useConfigStore()
const run = useRunStore()

const isImportRunning = computed(() =>
  run.state !== ImportState.IDLE && run.state !== ImportState.COMPLETED && run.state !== ImportState.FAILED
)

// Drag state
const draggedIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

// Track expanded state per file
const expandedFiles = ref<Set<string>>(new Set())

function toggleExpanded(fileId: string) {
  if (expandedFiles.value.has(fileId)) {
    expandedFiles.value.delete(fileId)
  } else {
    expandedFiles.value.add(fileId)
    emit('expand', fileId)
  }
}

function isExpanded(fileId: string): boolean {
  return expandedFiles.value.has(fileId)
}

function getMappingStatus(filename: string): 'valid' | 'partial' | 'none' {
  const mapping = config.getFileMapping(filename)
  if (!mapping?.model) return 'none'

  const file = props.files.find(f => f.name === filename)
  if (!file?.headers) return 'valid'

  const mappedCount = Object.keys(mapping.fieldMappings || {}).length
  if (mappedCount === 0) return 'none'
  if (mappedCount < file.headers.length) return 'partial'
  return 'valid'
}

// Native HTML5 drag-and-drop
function onDragStart(e: DragEvent, index: number) {
  if (isImportRunning.value) return
  draggedIndex.value = index
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
  }
}

function onDragOver(e: DragEvent, index: number) {
  if (isImportRunning.value) return
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move'
  }
  dragOverIndex.value = index
}

function onDragLeave() {
  dragOverIndex.value = null
}

function onDrop(e: DragEvent, dropIndex: number) {
  e.preventDefault()
  if (draggedIndex.value === null || isImportRunning.value) return

  const newOrder = props.files.map(f => f.name)
  const [moved] = newOrder.splice(draggedIndex.value, 1)
  newOrder.splice(dropIndex, 0, moved)

  emit('reorder', newOrder)
  config.setSequence(newOrder)

  draggedIndex.value = null
  dragOverIndex.value = null
}

function onDragEnd() {
  draggedIndex.value = null
  dragOverIndex.value = null
}
</script>

<template>
  <div class="d-flex flex-column gap-1">
    <div
      v-for="(file, index) in files"
      :key="file.id"
      class="csv-file-list__item"
      :class="{
        'csv-file-list__item--drag-over': dragOverIndex === index && draggedIndex !== index,
        'csv-file-list__item--dragging': draggedIndex === index
      }"
      :draggable="!isImportRunning"
      @dragstart="onDragStart($event, index)"
      @dragover="onDragOver($event, index)"
      @dragleave="onDragLeave"
      @drop="onDrop($event, index)"
      @dragend="onDragEnd"
    >
      <!-- File Header Row -->
      <div
        class="csv-file-list__header"
        role="button"
        tabindex="0"
        @click="toggleExpanded(file.id)"
        @keydown.enter="toggleExpanded(file.id)"
        @keydown.space.prevent="toggleExpanded(file.id)"
      >
        <!-- Drag Handle -->
        <div
          class="csv-file-list__handle"
          :class="{ 'csv-file-list__handle--disabled': isImportRunning }"
        >
          &#9776;
        </div>

        <!-- Order Number -->
        <span class="csv-file-list__order">
          {{ index + 1 }}
        </span>

        <!-- Status Indicator -->
        <MappingStatus :status="getMappingStatus(file.name)" compact />

        <!-- Expand Icon -->
        <span class="csv-file-list__chevron" :class="{ 'csv-file-list__chevron--open': isExpanded(file.id) }">
          &#9654;
        </span>

        <!-- Filename -->
        <span class="csv-file-list__filename">
          {{ file.name }}
        </span>

        <!-- Model (if mapped) -->
        <span
          v-if="config.getFileMapping(file.name)?.model"
          class="csv-file-list__model"
        >
          {{ config.getFileMapping(file.name)?.model }}
        </span>

        <!-- Row Count -->
        <span class="csv-file-list__rows">
          {{ file.rowCount?.toLocaleString() || '?' }} {{ $t('common.rows', 2) }}
        </span>

        <!-- Remove Button -->
        <button
          type="button"
          class="csv-file-list__remove"
          :title="$t('files.removeFile')"
          @click.stop="emit('remove', file.id)"
        >
          &times;
        </button>
      </div>

      <!-- Expanded Content -->
      <div
        v-if="isExpanded(file.id)"
        class="csv-file-list__expanded"
        :class="{ 'csv-file-list__expanded--readonly': isImportRunning }"
      >
        <slot name="expanded" :file="file" :readonly="isImportRunning" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.csv-file-list__item {
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  background: var(--bs-body-bg);
  transition: border-color 0.15s;
}
.csv-file-list__item--drag-over {
  border-color: var(--bs-primary);
  border-style: dashed;
}
.csv-file-list__item--dragging {
  opacity: 0.5;
}
.csv-file-list__header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem;
  cursor: pointer;
}
.csv-file-list__header:hover {
  background: var(--bs-tertiary-bg);
}
.csv-file-list__handle {
  cursor: grab;
  padding: 0.125rem;
  color: var(--bs-secondary-color);
  font-size: 0.75rem;
  user-select: none;
}
.csv-file-list__handle:hover {
  color: var(--bs-body-color);
}
.csv-file-list__handle--disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.csv-file-list__order {
  width: 1.5rem;
  text-align: center;
  font-size: 0.75rem;
  color: var(--bs-secondary-color);
  font-family: monospace;
}
.csv-file-list__chevron {
  font-size: 0.625rem;
  color: var(--bs-secondary-color);
  transition: transform 0.15s;
}
.csv-file-list__chevron--open {
  transform: rotate(90deg);
}
.csv-file-list__filename {
  flex: 1;
  font-size: 0.875rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.csv-file-list__model {
  font-size: 0.75rem;
  color: var(--bs-secondary-color);
  font-family: monospace;
}
.csv-file-list__rows {
  font-size: 0.75rem;
  color: var(--bs-secondary-color);
  font-variant-numeric: tabular-nums;
}
.csv-file-list__remove {
  padding: 0.25rem;
  color: var(--bs-secondary-color);
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
}
.csv-file-list__remove:hover {
  color: var(--bs-danger);
}
.csv-file-list__remove:focus-visible {
  color: var(--bs-danger);
  outline: 2px solid var(--bs-primary);
  outline-offset: -1px;
}
.csv-file-list__expanded {
  border-top: 1px solid var(--bs-border-color);
  padding: 0.75rem;
  background: var(--bs-tertiary-bg);
}
.csv-file-list__expanded--readonly {
  opacity: 0.6;
  pointer-events: none;
}
</style>
