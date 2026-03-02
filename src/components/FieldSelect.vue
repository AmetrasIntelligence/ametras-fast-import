<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { OdooField } from '@/api/odooClient'
import { useDropdown } from '@/composables/useDropdown'
import { useSearchDebounce } from '@/composables/useSearchDebounce'

const { t } = useI18n()

interface FieldOption {
  value: string
  label: string
  technical: string
  suffix?: string
  fieldType: string
  isRelational: boolean
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
    isRelational: false
  })
  opts.push({
    value: '.id',
    label: t('fieldSelect.databaseId'),
    technical: '.id',
    suffix: t('fieldSelect.dbIdSuffix'),
    fieldType: 'id',
    isRelational: false
  })

  const writableFields = props.fields.filter(f => !f.readonly)

  for (const f of writableFields) {
    opts.push({
      value: f.name,
      label: f.string,
      technical: f.name,
      fieldType: f.type,
      isRelational: f.type === 'many2one' || f.type === 'many2many'
    })

    if (f.type === 'many2one' || f.type === 'many2many') {
      opts.push({
        value: `${f.name}/id`,
        label: f.string,
        technical: `${f.name}/id`,
        suffix: t('fieldSelect.extIdSuffix'),
        fieldType: f.type,
        isRelational: true
      })
      opts.push({
        value: `${f.name}/.id`,
        label: f.string,
        technical: `${f.name}/.id`,
        suffix: t('fieldSelect.dbIdSuffix'),
        fieldType: f.type,
        isRelational: true
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
  <div class="csv-field-sel" ref="referenceEl">
    <!-- Trigger -->
    <button
      type="button"
      class="csv-field-sel__trigger"
      :disabled="disabled"
      @click="toggleOpen"
    >
      <span v-if="selectedOption" class="csv-field-sel__selected">
        <span class="csv-field-sel__tech">{{ selectedOption.technical }}</span>
        {{ selectedOption.label }}
        <span v-if="selectedOption.suffix" class="csv-field-sel__suffix">
          [{{ selectedOption.suffix }}]
        </span>
      </span>
      <span v-else class="text-body-secondary">{{ $t('common.skip') }}</span>
    </button>

    <!-- Dropdown (fixed position, teleported to body) -->
    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="dropdownEl"
        class="csv-field-sel__dropdown"
        :style="dropdownStyle"
      >
        <!-- Search -->
        <div class="csv-field-sel__search">
          <input
            ref="searchInputEl"
            v-model="searchQuery"
            type="text"
            :placeholder="$t('fieldSelect.searchPlaceholder')"
            class="form-control form-control-sm"
          />
        </div>

        <!-- Results -->
        <div class="csv-field-sel__results">
          <!-- Skip option -->
          <button
            type="button"
            class="csv-field-sel__option"
            :class="{ 'csv-field-sel__option--selected': !modelValue }"
            @click="selectSkip"
          >
            <span class="csv-field-sel__check">{{ !modelValue ? '&#10003;' : '' }}</span>
            <div class="csv-field-sel__option-text">
              <div class="text-body-secondary">{{ $t('common.skip') }}</div>
            </div>
          </button>

          <div
            v-if="filteredOptions.length === 0"
            class="csv-field-sel__empty"
          >
            {{ $t('fieldSelect.noResults') }}
          </div>

          <button
            v-for="option in filteredOptions"
            :key="option.value"
            type="button"
            class="csv-field-sel__option"
            :class="{ 'csv-field-sel__option--selected': option.value === modelValue }"
            @click="selectOption(option)"
          >
            <span class="csv-field-sel__check">{{ option.value === modelValue ? '&#10003;' : '' }}</span>
            <div class="csv-field-sel__option-text">
              <div>
                {{ option.label }}
                <span v-if="option.suffix" class="csv-field-sel__suffix">
                  [{{ option.suffix }}]
                </span>
              </div>
              <div class="csv-field-sel__tech">{{ option.technical }}</div>
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
  font-size: 0.8rem;
  text-align: left;
  background: var(--bs-body-bg);
  cursor: pointer;
  font-family: inherit;
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

<!-- Global styles for teleported dropdown -->
<style>
.csv-field-sel__tech {
  font-family: monospace;
  font-size: 0.7rem;
  color: var(--bs-secondary-color);
  margin-right: 0.25rem;
}
.csv-field-sel__suffix {
  font-size: 0.7rem;
  color: var(--bs-primary);
  margin-left: 0.125rem;
}
.csv-field-sel__dropdown {
  position: fixed;
  z-index: 1000;
  width: 400px;
  max-width: calc(100vw - 2rem);
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  background: var(--bs-body-bg);
  box-shadow: var(--bs-box-shadow-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.csv-field-sel__search {
  flex-shrink: 0;
  padding: 0.5rem;
  border-bottom: 1px solid var(--bs-border-color);
}
.csv-field-sel__results {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.csv-field-sel__empty {
  padding: 1rem;
  text-align: center;
  font-size: 0.875rem;
  color: var(--bs-secondary-color);
}
.csv-field-sel__option {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  text-align: left;
  font-size: 0.875rem;
  background: none;
  border: none;
  cursor: pointer;
  font-family: inherit;
}
.csv-field-sel__option:hover {
  background: var(--bs-tertiary-bg);
}
.csv-field-sel__option--selected {
  background: var(--bs-primary-bg-subtle);
}
.csv-field-sel__check {
  width: 1rem;
  flex-shrink: 0;
  color: var(--bs-primary);
  font-size: 0.875rem;
}
.csv-field-sel__option-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.csv-field-sel__option-text > div {
  overflow: hidden;
  text-overflow: ellipsis;
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
