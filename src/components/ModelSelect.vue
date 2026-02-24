<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { fetchModels, type OdooModel } from '@/api/odooClient'
import { useDropdown } from '@/composables/useDropdown'

// Session-level cache
let cachedModels: OdooModel[] | null = null

const props = defineProps<{
  modelValue: string | null
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const models = ref<OdooModel[]>([])
const loading = ref(false)
const searchQuery = ref('')
const searchInputEl = ref<HTMLInputElement | null>(null)

let debounceTimer: ReturnType<typeof setTimeout> | null = null
const debouncedQuery = ref('')

const {
  isOpen,
  triggerRef: referenceEl,
  dropdownRef: dropdownEl,
  dropdownStyle,
  toggle,
  close
} = useDropdown({
  dropdownHeight: 320,
  dropdownWidth: 360,
  minSpaceBelow: 180,
  onOpen: () => {
    searchQuery.value = ''
    debouncedQuery.value = ''
    setTimeout(() => searchInputEl.value?.focus(), 50)
  }
})

watch(searchQuery, (val) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debouncedQuery.value = val
  }, 200)
})

const filteredModels = computed(() => {
  if (!debouncedQuery.value) return models.value.slice(0, 50)

  const q = debouncedQuery.value.toLowerCase()
  return models.value
    .filter(m =>
      m.model.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q)
    )
    .slice(0, 50)
})

const selectedModel = computed(() =>
  models.value.find(m => m.model === props.modelValue)
)

onMounted(async () => {
  if (cachedModels) {
    models.value = cachedModels
    return
  }

  loading.value = true
  try {
    models.value = await fetchModels()
    cachedModels = models.value
  } catch {
    // Models will be empty
  } finally {
    loading.value = false
  }
})

function toggleOpen() {
  if (props.disabled) return
  toggle()
}

function selectModel(model: OdooModel) {
  emit('update:modelValue', model.model)
  close()
  searchQuery.value = ''
}

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>

<template>
  <div class="csv-model-select" ref="referenceEl">
    <!-- Trigger -->
    <button
      type="button"
      class="csv-model-select__trigger"
      :disabled="disabled"
      @click="toggleOpen"
    >
      <span v-if="selectedModel" class="csv-model-select__selected">
        <span class="csv-model-select__tech">{{ selectedModel.model }}</span>
        {{ selectedModel.name }}
      </span>
      <span v-else class="csv-text-muted">{{ $t('modelSelect.placeholder') }}</span>
      <span v-if="loading" class="csv-model-select__spinner" />
    </button>

    <!-- Dropdown (teleported to body for proper z-index) -->
    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="dropdownEl"
        class="csv-model-select__dropdown"
        :style="dropdownStyle"
      >
        <!-- Search -->
        <div class="csv-model-select__search">
          <input
            ref="searchInputEl"
            v-model="searchQuery"
            type="text"
            :placeholder="$t('modelSelect.searchPlaceholder')"
            class="csv-model-select__search-input"
          />
        </div>

        <!-- Results -->
        <div class="csv-model-select__results">
          <div
            v-if="filteredModels.length === 0"
            class="csv-model-select__empty"
          >
            {{ $t('modelSelect.noResults') }}
          </div>

          <button
            v-for="model in filteredModels"
            :key="model.id"
            type="button"
            class="csv-model-select__option"
            :class="{ 'csv-model-select__option--selected': model.model === modelValue }"
            @click="selectModel(model)"
          >
            <span class="csv-model-select__check" v-if="model.model === modelValue">&#10003;</span>
            <span class="csv-model-select__check" v-else />
            <div class="csv-model-select__option-text">
              <div>{{ model.name }}</div>
              <div class="csv-model-select__tech">{{ model.model }}</div>
            </div>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.csv-model-select {
  position: relative;
}
.csv-model-select__trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.875rem;
  text-align: left;
  background: white;
  cursor: pointer;
  font-family: inherit;
}
.csv-model-select__trigger:disabled {
  background: #f3f4f6;
  cursor: not-allowed;
}
.csv-model-select__selected {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.csv-model-select__spinner {
  width: 1rem;
  height: 1rem;
  border: 2px solid #e5e7eb;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: csv-spin 1s linear infinite;
}
</style>

<!-- Global styles for teleported dropdown -->
<style>
.csv-model-select__tech {
  font-family: monospace;
  font-size: 0.75rem;
  color: #6b7280;
  margin-right: 0.25rem;
}
.csv-model-select__dropdown {
  position: fixed;
  z-index: 1000;
  width: 360px;
  max-width: calc(100vw - 2rem);
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  background: white;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1), 0 1px 3px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.csv-model-select__search {
  flex-shrink: 0;
  padding: 0.5rem;
  border-bottom: 1px solid #e5e7eb;
}
.csv-model-select__search-input {
  width: 100%;
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.875rem;
  font-family: inherit;
}
.csv-model-select__search-input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}
.csv-model-select__results {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.csv-model-select__empty {
  padding: 1rem;
  text-align: center;
  font-size: 0.875rem;
  color: #6b7280;
}
.csv-model-select__option {
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
.csv-model-select__option:hover {
  background: #f3f4f6;
}
.csv-model-select__option--selected {
  background: #eff6ff;
}
.csv-model-select__check {
  width: 1rem;
  flex-shrink: 0;
  color: #2563eb;
  font-size: 0.875rem;
}
.csv-model-select__option-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.csv-model-select__option-text > div {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
