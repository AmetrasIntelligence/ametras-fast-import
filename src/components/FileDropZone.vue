<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  compact?: boolean
}>()

const emit = defineEmits<{
  filesDropped: [files: File[]]
  browse: []
}>()

const isDragOver = ref(false)
let dragCounter = 0

function onDragEnter(e: DragEvent) {
  e.preventDefault()
  dragCounter++
  isDragOver.value = true
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  dragCounter--
  if (dragCounter === 0) {
    isDragOver.value = false
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
  dragCounter = 0

  const files = Array.from(e.dataTransfer?.files || [])
    .filter(f => f.name.endsWith('.csv'))

  if (files.length > 0) {
    emit('filesDropped', files)
  }
}
</script>

<template>
  <div
    class="csv-drop-zone"
    :class="{
      'csv-drop-zone--active': isDragOver,
      'csv-drop-zone--compact': compact
    }"
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <div class="d-flex align-items-center gap-2" :class="{ 'flex-column': !compact }">
      <svg
        v-if="!compact"
        class="csv-drop-zone__icon"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.5"
          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
        />
      </svg>
      <p :class="compact ? 'small text-body-secondary mb-0' : 'small text-body-secondary mb-0'" style="font-size: 0.75rem;">
        <span v-if="isDragOver">{{ $t('files.dropZone.drop') }}</span>
        <span v-else>
          {{ compact ? $t('files.dropZone.addMore') : $t('files.dropZone.dragAndDrop') }}
          <button
            type="button"
            class="csv-drop-zone__browse"
            @click="$emit('browse')"
          >
            {{ $t('files.dropZone.browse') }}
          </button>
        </span>
      </p>
    </div>
  </div>
</template>

<style scoped>
.csv-drop-zone {
  border: 2px dashed var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  padding: 2rem;
  text-align: center;
  transition: border-color 0.15s, background-color 0.15s;
}
.csv-drop-zone:hover {
  border-color: var(--bs-secondary-color);
}
.csv-drop-zone--active {
  border-color: var(--bs-primary);
  background-color: var(--bs-primary-bg-subtle);
}
.csv-drop-zone--compact {
  padding: 0.75rem;
  border-width: 1px;
  border-color: var(--bs-border-color);
}
.csv-drop-zone--compact:hover {
  border-color: var(--bs-secondary-color);
  background-color: var(--bs-tertiary-bg);
}
.csv-drop-zone__icon {
  width: 2.5rem;
  height: 2.5rem;
  color: var(--bs-secondary-color);
}
.csv-drop-zone__browse {
  color: var(--bs-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
  background: none;
  border: none;
  font: inherit;
  cursor: pointer;
  padding: 0;
}
</style>
