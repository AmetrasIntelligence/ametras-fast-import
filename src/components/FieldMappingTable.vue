<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { fetchModelFields, type OdooField } from '@/api/odooClient'
import type { FieldMapping, FieldTransform } from '@/types/fieldMapping'
import { STANDARD_DB_ID_MODELS } from '@/types/fieldMapping'
import { detectTransform } from '@/utils/smartFieldMapping'

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

// Build field lookup map
const fieldMap = computed(() => {
  const map = new Map<string, OdooField>()
  for (const field of modelFields.value) {
    map.set(field.name, field)
  }
  return map
})

// Actions
function setMapping(csvHeader: string, odooField: string) {
  if (!odooField) {
    clearMapping(csvHeader)
    return
  }

  // Determine base field name (strip /id or /.id suffix if present)
  const baseName = odooField.endsWith('/.id')
    ? odooField.slice(0, -4)
    : odooField.endsWith('/id')
      ? odooField.slice(0, -3)
      : odooField

  const field = fieldMap.value.get(baseName)

  // Auto-detect required from Odoo field metadata
  const required = field?.required ?? false

  // Auto-detect transform based on header pattern and field type
  const transform: FieldTransform = field
    ? detectTransform(csvHeader, field)
    : { type: 'passthrough' }

  const mapping: FieldMapping = {
    filename: props.filename,
    csvHeader,
    odooField,
    required,
    transform
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

// Format transform for display
function formatTransform(transform: FieldTransform): string {
  switch (transform.type) {
    case 'passthrough':
      return 'passthrough'
    case 'm2o_ref':
      return `m2o → ${transform.model}`
    case 'm2m_ref':
      return `m2m → ${transform.model}`
    case 'db_id':
      return `db_id → ${transform.model}`
  }
}

// Get CSS class for transform badge
function getTransformClass(transform: FieldTransform): string {
  switch (transform.type) {
    case 'passthrough':
      return 'csv-transform-badge--passthrough'
    case 'm2o_ref':
      return 'csv-transform-badge--m2o'
    case 'm2m_ref':
      return 'csv-transform-badge--m2m'
    case 'db_id':
      return 'csv-transform-badge--dbid'
  }
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
            <th class="csv-text-left csv-px-3 csv-py-2 csv-font-medium csv-w-32">Transform</th>
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
                <template v-for="field in modelFields.filter(f => !f.readonly)" :key="field.name">
                  <!-- Regular field -->
                  <option :value="field.name">
                    {{ field.name }} ({{ field.string }}){{ field.required ? ' *' : '' }}
                  </option>
                  <!-- Relational field options: /id and /.id -->
                  <template v-if="field.type === 'many2one' || field.type === 'many2many'">
                    <option :value="`${field.name}/id`">
                      {{ field.name }}/id → ext ID ({{ field.relation }})
                    </option>
                    <option :value="`${field.name}/.id`">
                      {{ field.name }}/.id → db ID ({{ field.relation }}){{ !STANDARD_DB_ID_MODELS.has(field.relation || '') ? ' ⚠' : '' }}
                    </option>
                  </template>
                </template>
              </select>
              <span v-else class="csv-font-mono csv-text-xs">
                {{ localMappings.get(header)?.odooField || '-' }}
              </span>
            </td>

            <!-- Transform (auto-detected) -->
            <td class="csv-px-3 csv-py-2">
              <span
                v-if="localMappings.has(header)"
                class="csv-transform-badge"
                :class="getTransformClass(localMappings.get(header)!.transform)"
              >
                {{ formatTransform(localMappings.get(header)!.transform) }}
              </span>
              <span v-else class="csv-text-muted">-</span>
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

/* Transform badges */
.csv-transform-badge {
  display: inline-block;
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
  font-size: 0.625rem;
  font-family: ui-monospace, monospace;
  white-space: nowrap;
}
.csv-transform-badge--passthrough {
  background: #f3f4f6;
  color: #6b7280;
}
.csv-transform-badge--m2o {
  background: #dbeafe;
  color: #1d4ed8;
}
.csv-transform-badge--m2m {
  background: #e0e7ff;
  color: #4338ca;
}
.csv-transform-badge--dbid {
  background: #fef3c7;
  color: #b45309;
}
</style>
