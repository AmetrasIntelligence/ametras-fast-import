<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { OdooField } from '@/api/odooClient'

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

const isOpen = ref(false)
const searchQuery = ref('')
const debouncedQuery = ref('')
const referenceEl = ref<HTMLElement | null>(null)
const dropdownEl = ref<HTMLElement | null>(null)
const searchInputEl = ref<HTMLInputElement | null>(null)

let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(searchQuery, (val) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debouncedQuery.value = val
  }, 150)
})

const allOptions = computed<FieldOption[]>(() => {
  const opts: FieldOption[] = []

  // Special id options at the top (for upsert)
  opts.push({
    value: 'id',
    label: 'External ID',
    technical: 'id',
    suffix: 'ext ID',
    fieldType: 'id',
    isRelational: false
  })
  opts.push({
    value: '.id',
    label: 'Database ID',
    technical: '.id',
    suffix: 'db ID',
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
        suffix: 'ext ID',
        fieldType: f.type,
        isRelational: true
      })
      opts.push({
        value: `${f.name}/.id`,
        label: f.string,
        technical: `${f.name}/.id`,
        suffix: 'db ID',
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
  isOpen.value = !isOpen.value
  if (isOpen.value) {
    searchQuery.value = ''
    debouncedQuery.value = ''
    setTimeout(() => searchInputEl.value?.focus(), 50)
  }
}

function selectOption(option: FieldOption) {
  emit('update:modelValue', option.value)
  isOpen.value = false
  searchQuery.value = ''
}

function selectSkip() {
  emit('update:modelValue', '')
  isOpen.value = false
  searchQuery.value = ''
}

function handleClickOutside(e: MouseEvent) {
  if (
    !referenceEl.value?.contains(e.target as Node) &&
    !dropdownEl.value?.contains(e.target as Node)
  ) {
    isOpen.value = false
  }
}

watch(isOpen, (open) => {
  if (open) {
    document.addEventListener('click', handleClickOutside, true)
  } else {
    document.removeEventListener('click', handleClickOutside, true)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside, true)
  if (debounceTimer) clearTimeout(debounceTimer)
})
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
      <span v-else class="csv-text-muted">(skip)</span>
    </button>

    <!-- Dropdown -->
    <div
      v-if="isOpen"
      ref="dropdownEl"
      class="csv-field-sel__dropdown"
    >
      <!-- Search -->
      <div class="csv-field-sel__search">
        <input
          ref="searchInputEl"
          v-model="searchQuery"
          type="text"
          placeholder="Search by name or technical name..."
          class="csv-field-sel__search-input"
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
            <div class="csv-text-muted">(skip)</div>
          </div>
        </button>

        <div
          v-if="filteredOptions.length === 0"
          class="csv-field-sel__empty"
        >
          No fields found
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
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.8rem;
  text-align: left;
  background: white;
  cursor: pointer;
  font-family: inherit;
}
.csv-field-sel__trigger:disabled {
  background: #f3f4f6;
  cursor: not-allowed;
}
.csv-field-sel__selected {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.csv-field-sel__tech {
  font-family: monospace;
  font-size: 0.7rem;
  color: #6b7280;
  margin-right: 0.25rem;
}
.csv-field-sel__suffix {
  font-size: 0.7rem;
  color: #2563eb;
  margin-left: 0.125rem;
}
.csv-field-sel__dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 50;
  width: 380px;
  border: 1px solid #e5e7eb;
  border-radius: var(--radius, 0.375rem);
  background: white;
  box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);
  overflow: hidden;
}
.csv-field-sel__search {
  padding: 0.5rem;
  border-bottom: 1px solid #e5e7eb;
}
.csv-field-sel__search-input {
  width: 100%;
  height: 1.75rem;
  padding: 0 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.8rem;
  font-family: inherit;
}
.csv-field-sel__search-input:focus {
  outline: none;
  border-color: #2563eb;
}
.csv-field-sel__results {
  overflow-y: auto;
  max-height: 280px;
}
.csv-field-sel__empty {
  padding: 1rem;
  text-align: center;
  font-size: 0.8rem;
  color: #6b7280;
}
.csv-field-sel__option {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  text-align: left;
  font-size: 0.8rem;
  background: none;
  border: none;
  cursor: pointer;
  font-family: inherit;
}
.csv-field-sel__option:hover {
  background: #f3f4f6;
}
.csv-field-sel__option--selected {
  background: #f3f4f6;
}
.csv-field-sel__check {
  width: 0.875rem;
  flex-shrink: 0;
  color: #2563eb;
  font-size: 0.7rem;
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
  font-size: 0.625rem;
  color: #9ca3af;
  font-family: monospace;
  padding: 0.0625rem 0.25rem;
  background: #f3f4f6;
  border-radius: 2px;
}
</style>
