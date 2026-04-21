<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { OdooField } from '@/api/odooClient'
import type { FieldTransform } from '@/types/fieldMapping'
import { STANDARD_DB_ID_MODELS } from '@/types/fieldMapping'
import FieldSelect from './FieldSelect.vue'
import TransformSelect from './TransformSelect.vue'

const { t } = useI18n()

const props = defineProps<{
  headers: string[]
  fieldMappings: Record<string, string>
  fields: OdooField[]
  strict: boolean
  /** Hide the strict toggle (e.g. in standalone mode where it has no effect) */
  hideStrict?: boolean
  /** Returns field lookup map for computing transforms */
  getFieldLookup: () => Map<string, OdooField>
  /** Compute transform/required metadata for a header→field mapping */
  getFieldMetadata: (csvHeader: string, odooField: string) => { transform: FieldTransform; required: boolean }
}>()

const emit = defineEmits<{
  'update:fieldMapping': [csvHeader: string, odooField: string]
  'update:transform': [csvHeader: string, transform: FieldTransform]
  'update:strict': [strict: boolean]
}>()

function getMappingInfo(csvHeader: string): { transform: FieldTransform; required: boolean; isStandardDbId: boolean } | null {
  if (!props.fieldMappings[csvHeader]) return null

  const odooField = props.fieldMappings[csvHeader]
  const { transform, required } = props.getFieldMetadata(csvHeader, odooField)
  const isStandardDbId = transform.type === 'db_id' && STANDARD_DB_ID_MODELS.has(transform.model)

  return { transform, required, isStandardDbId }
}

function getFieldInfo(csvHeader: string): { fieldType?: string; relationModel?: string } {
  if (!props.fieldMappings[csvHeader]) return {}

  const odooField = props.fieldMappings[csvHeader]
  const baseName = odooField.endsWith('/.id')
    ? odooField.slice(0, -4)
    : odooField.endsWith('/id')
      ? odooField.slice(0, -3)
      : odooField

  const fieldLookup = props.getFieldLookup()
  const field = fieldLookup.get(baseName)

  return {
    fieldType: field?.type,
    relationModel: field?.relation
  }
}

const mappedCount = computed(() => Object.keys(props.fieldMappings).length)
</script>

<template>
  <div class="csv-config-section">
    <div class="csv-config-section__header">
      <span>{{ t('config.fieldMappings') }}</span>
      <div class="d-flex align-items-center gap-3">
        <small class="text-body-secondary">
          {{ mappedCount }} {{ t('common.of') }} {{ headers.length }} {{ t('config.mapped') }}
        </small>
        <label v-if="!hideStrict" class="csv-field-mapping__strict-toggle" :title="t('config.strictTooltip')">
          <input
            type="checkbox"
            :checked="strict"
            @change="emit('update:strict', ($event.target as HTMLInputElement).checked)"
          />
          <small>{{ t('config.strict') }}</small>
        </label>
      </div>
    </div>

    <div class="csv-field-mapping__table">
      <div class="csv-field-mapping__row csv-field-mapping__row--header">
        <div class="csv-field-mapping__col csv-field-mapping__col--csv">{{ t('config.csvColumn') }}</div>
        <div class="csv-field-mapping__col csv-field-mapping__col--arrow"></div>
        <div class="csv-field-mapping__col csv-field-mapping__col--field">{{ t('config.odooField') }}</div>
        <div class="csv-field-mapping__col csv-field-mapping__col--transform">{{ t('config.transform') }}</div>
        <div class="csv-field-mapping__col csv-field-mapping__col--req">{{ t('config.req') }}</div>
      </div>

      <div
        v-for="header in headers"
        :key="header"
        class="csv-field-mapping__row"
        :class="{ 'csv-field-mapping__row--mapped': fieldMappings[header] }"
      >
        <div class="csv-field-mapping__col csv-field-mapping__col--csv" :title="header">{{ header }}</div>
        <div class="csv-field-mapping__col csv-field-mapping__col--arrow">&rarr;</div>
        <div class="csv-field-mapping__col csv-field-mapping__col--field">
          <FieldSelect
            :model-value="fieldMappings[header] || ''"
            :fields="fields"
            @update:model-value="emit('update:fieldMapping', header, $event)"
          />
        </div>
        <div class="csv-field-mapping__col csv-field-mapping__col--transform">
          <TransformSelect
            v-if="getMappingInfo(header)"
            :model-value="getMappingInfo(header)!.transform"
            :field-type="getFieldInfo(header).fieldType"
            :relation-model="getFieldInfo(header).relationModel"
            @update:model-value="emit('update:transform', header, $event)"
          />
          <span v-else class="text-body-secondary">-</span>
        </div>
        <div class="csv-field-mapping__col csv-field-mapping__col--req">
          <span v-if="getMappingInfo(header)" class="csv-field-mapping__req" :class="{ 'csv-field-mapping__req--active': getMappingInfo(header)?.required }">
            {{ getMappingInfo(header)?.required ? '&#10003;' : '-' }}
          </span>
          <span v-else>-</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

.csv-field-mapping__table {
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  overflow: hidden;
}
.csv-field-mapping__row {
  display: grid;
  grid-template-columns: minmax(120px, 180px) 24px 1fr minmax(100px, 150px) 70px;
  gap: 0.5rem;
  align-items: center;
  padding: 0.375rem 0.75rem;
  border-bottom: 1px solid var(--bs-border-color-translucent);
}
.csv-field-mapping__row:last-child {
  border-bottom: none;
}
.csv-field-mapping__row--header {
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--bs-secondary-color);
  background: var(--bs-tertiary-bg);
  border-bottom: 1px solid var(--bs-border-color);
}
.csv-field-mapping__row--mapped {
  background: var(--bs-success-bg-subtle);
}
.csv-field-mapping__col--csv {
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--bs-body-color);
}
.csv-field-mapping__col--arrow {
  text-align: center;
  color: var(--bs-secondary-color);
  font-size: 0.75rem;
}
.csv-field-mapping__col--transform {
  font-size: 0.7rem;
}
.csv-field-mapping__col--req {
  text-align: center;
  font-size: 0.75rem;
}
.csv-field-mapping__req {
  color: var(--bs-secondary-color);
}
.csv-field-mapping__req--active {
  color: var(--bs-success);
  font-weight: 600;
}
.csv-field-mapping__strict-toggle {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
  padding: 0.125rem 0.375rem;
  border-radius: var(--bs-border-radius-sm);
  background: var(--bs-tertiary-bg);
}
.csv-field-mapping__strict-toggle:hover {
  background: var(--bs-secondary-bg-subtle);
}
.csv-field-mapping__strict-toggle input {
  margin: 0;
}
</style>
