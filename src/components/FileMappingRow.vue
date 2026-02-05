<script setup lang="ts">
import { computed } from 'vue'
import type { FileMapping } from '@/stores/config'
import type { OdooField } from '@/api/odooClient'
import MappingStatus from './MappingStatus.vue'

const props = defineProps<{
  filename: string
  headers: string[]
  mapping: FileMapping | undefined
  fields: OdooField[]
  readonly?: boolean
}>()

const emit = defineEmits<{
  updateField: [csvCol: string, odooField: string]
}>()

const status = computed((): 'valid' | 'partial' | 'none' => {
  if (!props.mapping?.model) return 'none'

  const mapped = Object.keys(props.mapping.fieldMappings || {})
  if (mapped.length === 0) return 'none'
  if (mapped.length < props.headers.length) return 'partial'
  return 'valid'
})

const writableFields = computed(() =>
  props.fields.filter(f => !f.readonly)
)
</script>

<template>
  <div>
    <div class="csv-flex csv-items-center csv-justify-between csv-mb-3">
      <span class="csv-text-sm csv-font-medium">Field Mapping</span>
      <MappingStatus :status="status" />
    </div>

    <div class="csv-field-mapping-list">
      <div
        v-for="header in headers"
        :key="header"
        class="csv-field-mapping-row"
      >
        <span class="csv-field-mapping-row__header">{{ header }}</span>
        <span class="csv-text-muted">&rarr;</span>
        <select
          :value="mapping?.fieldMappings[header] || ''"
          :disabled="readonly"
          class="csv-field-mapping-row__select"
          @change="emit('updateField', header, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">(skip)</option>
          <option
            v-for="field in writableFields"
            :key="field.name"
            :value="field.name"
          >
            {{ field.string }} ({{ field.name }})
          </option>
        </select>
      </div>
    </div>
  </div>
</template>

<style scoped>
.csv-field-mapping-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.csv-field-mapping-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.csv-field-mapping-row__header {
  width: 10rem;
  font-size: 0.875rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.csv-field-mapping-row__select {
  flex: 1;
  height: 1.75rem;
  padding: 0 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.8rem;
  font-family: inherit;
  background: white;
}
.csv-field-mapping-row__select:disabled {
  background: #f3f4f6;
  cursor: not-allowed;
}
</style>
