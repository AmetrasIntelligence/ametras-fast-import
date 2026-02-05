<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { fetchModelFields, type OdooField } from '@/api/odooClient'
import type { FieldMapping } from '@/types/fieldMapping'

const props = defineProps<{
  filename: string
  csvHeaders: string[]
  model: string
  existingMappings: FieldMapping[]
  readonly?: boolean
}>()

const emit = defineEmits<{
  update: [mappings: FieldMapping[]]
}>()

const modelFields = ref<OdooField[]>([])
const loading = ref(false)

// Local state for editing
const localMappings = ref<Map<string, FieldMapping>>(new Map())

// Initialize from existing mappings
watch(() => props.existingMappings, (mappings) => {
  localMappings.value = new Map(
    mappings
      .filter(m => m.filename === props.filename)
      .map(m => [m.csvHeader, m])
  )
}, { immediate: true })

// Fetch fields when model changes
watch(() => props.model, async (model) => {
  if (!model) return
  loading.value = true
  try {
    modelFields.value = await fetchModelFields(model)
  } finally {
    loading.value = false
  }
}, { immediate: true })

// Computed: unmapped headers
const unmappedHeaders = computed(() =>
  props.csvHeaders.filter(h => !localMappings.value.has(h))
)

// Computed: mapping status per header
function getMappingStatus(header: string): 'mapped' | 'required-missing' | 'unmapped' {
  const mapping = localMappings.value.get(header)
  if (!mapping) return 'unmapped'
  if (mapping.required && !props.csvHeaders.includes(header)) return 'required-missing'
  return 'mapped'
}

// Actions
function setMapping(csvHeader: string, odooField: string) {
  if (!odooField) {
    clearMapping(csvHeader)
    return
  }
  const mapping: FieldMapping = {
    filename: props.filename,
    csvHeader,
    odooField,
    required: false,
    transform: { type: 'passthrough' }
  }
  localMappings.value.set(csvHeader, mapping)
  emitUpdate()
}

function clearMapping(csvHeader: string) {
  localMappings.value.delete(csvHeader)
  emitUpdate()
}

function toggleRequired(csvHeader: string) {
  const mapping = localMappings.value.get(csvHeader)
  if (mapping) {
    mapping.required = !mapping.required
    emitUpdate()
  }
}

function emitUpdate() {
  emit('update', Array.from(localMappings.value.values()))
}
</script>

<template>
  <div class="csv-space-y-2">
    <!-- Header -->
    <div class="csv-flex csv-items-center csv-justify-between csv-text-sm csv-text-muted csv-mb-2">
      <span>{{ csvHeaders.length }} CSV columns</span>
      <span>{{ localMappings.size }} mapped</span>
    </div>

    <!-- Mapping Table -->
    <div class="csv-field-mapping-table">
      <table class="csv-w-full csv-text-sm">
        <thead>
          <tr class="csv-field-mapping-table__header">
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium">CSV Header</th>
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium csv-w-8"></th>
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium">Odoo Field</th>
            <th class="csv-text-center csv-px-3 csv-py-2 csv-font-medium csv-w-16">Req</th>
            <th class="csv-text-center csv-px-3 csv-py-2 csv-font-medium csv-w-16"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="header in csvHeaders"
            :key="header"
            class="csv-field-mapping-table__row"
            :class="{
              'csv-field-mapping-table__row--mapped': getMappingStatus(header) === 'mapped',
              'csv-field-mapping-table__row--missing': getMappingStatus(header) === 'required-missing'
            }"
          >
            <!-- CSV Header -->
            <td class="csv-px-3 csv-py-2 csv-font-mono csv-text-xs">
              {{ header }}
            </td>

            <!-- Arrow -->
            <td class="csv-px-3 csv-py-2 csv-text-muted">&rarr;</td>

            <!-- Odoo Field Select -->
            <td class="csv-px-3 csv-py-2">
              <select
                v-if="!readonly"
                :value="localMappings.get(header)?.odooField || ''"
                class="csv-field-select"
                @change="(e) => setMapping(header, (e.target as HTMLSelectElement).value)"
              >
                <option value="">-- Select field --</option>
                <option
                  v-for="field in modelFields.filter(f => !f.readonly)"
                  :key="field.name"
                  :value="field.name"
                >
                  {{ field.name }} ({{ field.string }})
                </option>
              </select>
              <span v-else class="csv-font-mono csv-text-xs">
                {{ localMappings.get(header)?.odooField || '-' }}
              </span>
            </td>

            <!-- Required Toggle -->
            <td class="csv-text-center csv-px-3 csv-py-2">
              <button
                v-if="localMappings.has(header) && !readonly"
                type="button"
                class="csv-field-mapping-table__req-btn"
                :class="{ 'csv-field-mapping-table__req-btn--active': localMappings.get(header)?.required }"
                @click="toggleRequired(header)"
                title="Toggle required"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="csv-w-3.5 csv-h-3.5">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
              </button>
            </td>

            <!-- Clear Button -->
            <td class="csv-text-center csv-px-3 csv-py-2">
              <button
                v-if="localMappings.has(header) && !readonly"
                type="button"
                class="csv-field-mapping-table__clear-btn"
                @click="clearMapping(header)"
                title="Clear mapping"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="csv-w-3.5 csv-h-3.5">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Unmapped Warning -->
    <div
      v-if="unmappedHeaders.length > 0 && !readonly"
      class="csv-field-mapping-table__warning"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="csv-w-4 csv-h-4 csv-text-orange-600">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div>
        <span class="csv-font-medium" style="color: #9a3412;">
          {{ unmappedHeaders.length }} unmapped columns
        </span>
        <span style="color: #c2410c;">
          — will be ignored during import
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.csv-field-mapping-table {
  border: 1px solid #e5e7eb;
  border-radius: var(--radius, 0.375rem);
  overflow: hidden;
}
.csv-field-mapping-table__header {
  background: #f9fafb;
}
.csv-field-mapping-table__row {
  border-top: 1px solid #e5e7eb;
}
.csv-field-mapping-table__row--mapped {
  background: #f0fdf4;
}
.csv-field-mapping-table__row--missing {
  background: #fef2f2;
}
.csv-field-select {
  width: 100%;
  height: 1.75rem;
  padding: 0 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.75rem;
  font-family: inherit;
  background: white;
}
.csv-field-mapping-table__req-btn {
  padding: 0.25rem;
  border-radius: 0.25rem;
  border: none;
  background: none;
  color: #9ca3af;
  cursor: pointer;
}
.csv-field-mapping-table__req-btn:hover {
  background: #f3f4f6;
}
.csv-field-mapping-table__req-btn--active {
  color: #ea580c;
  background: #fff7ed;
}
.csv-field-mapping-table__clear-btn {
  padding: 0.25rem;
  border-radius: 0.25rem;
  border: none;
  background: none;
  color: #9ca3af;
  cursor: pointer;
}
.csv-field-mapping-table__clear-btn:hover {
  color: #dc2626;
  background: #fef2f2;
}
.csv-field-mapping-table__warning {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem;
  background: #fff7ed;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.875rem;
}
</style>
