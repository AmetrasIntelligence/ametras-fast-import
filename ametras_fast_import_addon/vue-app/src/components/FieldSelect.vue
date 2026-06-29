<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { OdooField } from '@/api/odooClient'
import { useDropdown } from '@/composables/useDropdown'
import { useSearchDebounce } from '@/composables/useSearchDebounce'
import '@/assets/csv-dropdown.css'

const { t } = useI18n()

interface FieldOption {
  value: string
  label: string
  technical: string
  suffix?: string
  fieldType: string
  isRelational: boolean
  readonly: boolean
}

const props = defineProps<{
  modelValue: string
  fields: OdooField[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const searchInputEl = ref<HTMLInputElement | null>(null)

const { searchQuery, debouncedQuery, reset: resetSearch } = useSearchDebounce(150)

const {
  isOpen,
  triggerRef: referenceEl,
  dropdownRef: dropdownEl,
  dropdownStyle,
  toggle,
  close
} = useDropdown({
  dropdownHeight: 340,
  dropdownWidth: 400,
  minSpaceBelow: 180,
  onOpen: () => {
    resetSearch()
    setTimeout(() => searchInputEl.value?.focus(), 50)
  }
})

const allOptions = computed<FieldOption[]>(() => {
  const opts: FieldOption[] = []

  // Special id options at the top (for upsert)
  opts.push({
    value: 'id',
    label: t('fieldSelect.externalId'),
    technical: 'id',
    suffix: t('fieldSelect.extIdSuffix'),
    fieldType: 'id',
    isRelational: false,
    readonly: false
  })
  opts.push({
    value: '.id',
    label: t('fieldSelect.databaseId'),
    technical: '.id',
    suffix: t('fieldSelect.dbIdSuffix'),
    fieldType: 'id',
    isRelational: false,
    readonly: false
  })

  for (const f of props.fields) {
    opts.push({
      value: f.name,
      label: f.string,
      technical: f.name,
      fieldType: f.type,
      isRelational: f.type === 'many2one' || f.type === 'many2many',
      readonly: f.readonly
    })

    if (f.type === 'many2one' || f.type === 'many2many') {
      opts.push({
        value: `${f.name}/id`,
        label: f.string,
        technical: `${f.name}/id`,
        suffix: t('fieldSelect.extIdSuffix'),
        fieldType: f.type,
        isRelational: true,
        readonly: f.readonly
      })
      opts.push({
        value: `${f.name}/.id`,
        label: f.string,
        technical: `${f.name}/.id`,
        suffix: t('fieldSelect.dbIdSuffix'),
        fieldType: f.type,
        isRelational: true,
        readonly: f.readonly
      })
    }
  }

  return opts
})

const filteredOptions = computed(() => {
  if (!debouncedQuery.value) return allOptions.value.slice(0, 60)

  const q = debouncedQuery.value.toLowerCase()
  return allOptions.value
    .filter(o =>
      o.label.toLowerCase().includes(q) ||
      o.technical.toLowerCase().includes(q)
    )
    .slice(0, 60)
})

const selectedOption = computed(() =>
  allOptions.value.find(o => o.value === props.modelValue)
)

function toggleOpen() {
  if (props.disabled) return
  toggle()
}

function selectOption(option: FieldOption) {
  emit('update:modelValue', option.value)
  close()
  resetSearch()
}

function selectSkip() {
  emit('update:modelValue', '')
  close()
  resetSearch()
}
</script>

<template>
  <div ref="referenceEl" class="csv-field-sel">
    <!-- Trigger -->
    <button
      type="button"
      class="csv-field-sel__trigger"
      :disabled="disabled"
      aria-haspopup="listbox"
      :aria-expanded="isOpen"
      @click="toggleOpen"
    >
      <span v-if="selectedOption" class="csv-field-sel__selected">
        <span class="csv-dropdown__tech">{{ selectedOption.technical }}</span>
        {{ selectedOption.label }}
        <span v-if="selectedOption.suffix" class="csv-field-sel__suffix">
          [{{ selectedOption.suffix }}]
        </span>
        <span v-if="selectedOption.readonly" class="csv-field-sel__readonly-badge">
          {{ $t('fieldSelect.readOnly') }}
        </span>
      </span>
      <span v-else class="text-body-secondary">{{ $t('common.skip') }}</span>
    </button>

    <!-- Dropdown (fixed position, teleported to body) -->
    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="dropdownEl"
        class="csv-dropdown"
        :style="[dropdownStyle, { width: '400px' }]"
      >
        <!-- Search -->
        <div class="csv-dropdown__search">
          <input
            ref="searchInputEl"
            v-model="searchQuery"
            type="text"
            :placeholder="$t('fieldSelect.searchPlaceholder')"
            class="form-control form-control-sm"
          />
        </div>

        <!-- Results -->
        <div class="csv-dropdown__results">
          <!-- Skip option -->
          <button
            type="button"
            class="csv-dropdown__option"
            :class="{ 'csv-dropdown__option--selected': !modelValue }"
            @click="selectSkip"
          >
            <span class="csv-dropdown__check">{{ !modelValue ? '&#10003;' : '' }}</span>
            <div class="csv-dropdown__option-text">
              <div class="text-body-secondary">{{ $t('common.skip') }}</div>
            </div>
          </button>

          <div
            v-if="filteredOptions.length === 0"
            class="csv-dropdown__empty"
          >
            {{ $t('fieldSelect.noResults') }}
          </div>

          <button
            v-for="option in filteredOptions"
            :key="option.value"
            type="button"
            class="csv-dropdown__option"
            :class="{ 'csv-dropdown__option--selected': option.value === modelValue }"
            @click="selectOption(option)"
          >
            <span class="csv-dropdown__check">{{ option.value === modelValue ? '&#10003;' : '' }}</span>
            <div class="csv-dropdown__option-text">
              <div>
                {{ option.label }}
                <span v-if="option.suffix" class="csv-field-sel__suffix">
                  [{{ option.suffix }}]
                </span>
                <span v-if="option.readonly" class="csv-field-sel__readonly-badge">
                  {{ $t('fieldSelect.readOnly') }}
                </span>
              </div>
              <div class="csv-dropdown__tech">{{ option.technical }}</div>
            </div>
            <span class="csv-field-sel__type">{{ option.fieldType }}</span>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.csv-field-sel {
  position: relative;
  flex: 1;
}
.csv-field-sel__trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 1.75rem;
  padding: 0 0.5rem;
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  font-size: 0.875rem;
  text-align: left;
  background: var(--bs-body-bg);
  cursor: pointer;
  font-family: inherit;
}
.csv-field-sel__trigger:focus-visible {
  outline: 2px solid var(--bs-primary);
  outline-offset: -1px;
}
.csv-field-sel__trigger:disabled {
  background: var(--bs-tertiary-bg);
  cursor: not-allowed;
}
.csv-field-sel__selected {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<!-- Component-specific global styles (for teleported content) -->
<style>
.csv-field-sel__suffix {
  font-size: 0.7rem;
  color: var(--bs-primary);
  margin-left: 0.125rem;
}
.csv-field-sel__readonly-badge {
  font-size: 0.65rem;
  color: var(--bs-warning-text-emphasis, #664d03);
  background: var(--bs-warning-bg-subtle, #fff3cd);
  border: 1px solid var(--bs-warning-border-subtle, #ffda6a);
  border-radius: 3px;
  padding: 0.1rem 0.3rem;
  margin-left: 0.25rem;
  vertical-align: middle;
  white-space: nowrap;
}
.csv-field-sel__type {
  flex-shrink: 0;
  font-size: 0.7rem;
  color: var(--bs-secondary-color);
  font-family: monospace;
  padding: 0.125rem 0.375rem;
  background: var(--bs-tertiary-bg);
  border-radius: 3px;
}
</style>
