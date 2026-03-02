<script setup lang="ts">
import { computed } from 'vue'
import type { FieldTransform } from '@/types/fieldMapping'
import { STANDARD_DB_ID_MODELS } from '@/types/fieldMapping'

const props = defineProps<{
  modelValue: FieldTransform
  /** The related model for relational fields (e.g., 'res.partner') */
  relationModel?: string
  /** Field type: 'many2one', 'many2many', or other */
  fieldType?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: FieldTransform]
}>()

const isRelational = computed(() =>
  props.fieldType === 'many2one' || props.fieldType === 'many2many'
)

const isStandardDbIdModel = computed(() =>
  props.relationModel ? STANDARD_DB_ID_MODELS.has(props.relationModel) : false
)

interface TransformOption {
  value: string
  label: string
  transform: FieldTransform
  available: boolean
}

const options = computed<TransformOption[]>(() => {
  const opts: TransformOption[] = [
    {
      value: 'passthrough',
      label: '-',
      transform: { type: 'passthrough' },
      available: true
    }
  ]

  if (isRelational.value && props.relationModel) {
    if (props.fieldType === 'many2one') {
      opts.push({
        value: 'm2o_ref',
        label: `m2o → ${props.relationModel}`,
        transform: { type: 'm2o_ref', model: props.relationModel },
        available: true
      })
    } else if (props.fieldType === 'many2many') {
      opts.push({
        value: 'm2m_ref',
        label: `m2m → ${props.relationModel}`,
        transform: { type: 'm2m_ref', model: props.relationModel },
        available: true
      })
    }

    opts.push({
      value: 'db_id',
      label: `db_id → ${props.relationModel}`,
      transform: { type: 'db_id', model: props.relationModel },
      available: true
    })
  }

  return opts
})

const currentValue = computed(() => {
  return props.modelValue.type
})

const badgeClass = computed(() => {
  switch (props.modelValue.type) {
    case 'm2o_ref': return 'csv-transform-select--m2o'
    case 'm2m_ref': return 'csv-transform-select--m2m'
    case 'db_id': return isStandardDbIdModel.value
      ? 'csv-transform-select--dbid'
      : 'csv-transform-select--dbid-warn'
    default: return ''
  }
})

function handleChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  const option = options.value.find(o => o.value === value)
  if (option) {
    emit('update:modelValue', option.transform)
  }
}
</script>

<template>
  <select
    :value="currentValue"
    :disabled="disabled || options.length <= 1"
    class="csv-transform-select"
    :class="badgeClass"
    @change="handleChange"
  >
    <option
      v-for="opt in options"
      :key="opt.value"
      :value="opt.value"
      :disabled="!opt.available"
    >
      {{ opt.label }}
    </option>
  </select>
</template>

<style scoped>
.csv-transform-select {
  display: inline-block;
  padding: 0.1rem 0.3rem;
  border-radius: var(--bs-border-radius-sm);
  font-size: 0.6rem;
  font-family: ui-monospace, monospace;
  white-space: nowrap;
  background: var(--bs-tertiary-bg);
  color: var(--bs-secondary-color);
  border: 1px solid transparent;
  cursor: pointer;
  min-width: 3rem;
  max-width: 100%;
}

.csv-transform-select:hover:not(:disabled) {
  border-color: var(--bs-border-color);
}

.csv-transform-select:disabled {
  cursor: default;
  opacity: 0.7;
}

.csv-transform-select--m2o {
  background: var(--bs-primary-bg-subtle);
  color: var(--bs-primary-text-emphasis);
}

.csv-transform-select--m2m {
  background: var(--bs-info-bg-subtle);
  color: var(--bs-info-text-emphasis);
}

.csv-transform-select--dbid {
  background: var(--bs-warning-bg-subtle);
  color: var(--bs-warning-text-emphasis);
}

.csv-transform-select--dbid-warn {
  background: var(--bs-danger-bg-subtle);
  color: var(--bs-danger);
}
</style>
