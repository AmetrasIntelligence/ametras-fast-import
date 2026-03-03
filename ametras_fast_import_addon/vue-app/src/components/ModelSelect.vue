<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { fetchModels, type OdooModel } from '@/api/odooClient'
import { useDropdown } from '@/composables/useDropdown'
import { useSearchDebounce } from '@/composables/useSearchDebounce'
import '@/assets/csv-dropdown.css'

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
const searchInputEl = ref<HTMLInputElement | null>(null)

const { searchQuery, debouncedQuery, reset: resetSearch } = useSearchDebounce(200)

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
    resetSearch()
    setTimeout(() => searchInputEl.value?.focus(), 50)
  }
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

let abortController: AbortController | null = null

onMounted(async () => {
  if (cachedModels) {
    models.value = cachedModels
    return
  }

  abortController = new AbortController()
  loading.value = true
  try {
    const result = await fetchModels()
    if (!abortController.signal.aborted) {
      models.value = result
      cachedModels = result
    }
  } catch {
    // Models will be empty
  } finally {
    if (!abortController.signal.aborted) {
      loading.value = false
    }
  }
})

function toggleOpen() {
  if (props.disabled) return
  toggle()
}

function selectModel(model: OdooModel) {
  emit('update:modelValue', model.model)
  close()
  resetSearch()
}

onBeforeUnmount(() => {
  abortController?.abort()
})
</script>

<template>
  <div ref="referenceEl" class="csv-model-select">
    <!-- Trigger -->
    <button
      type="button"
      class="csv-model-select__trigger"
      :disabled="disabled"
      aria-haspopup="listbox"
      :aria-expanded="isOpen"
      @click="toggleOpen"
    >
      <span v-if="selectedModel" class="csv-model-select__selected">
        <span class="csv-dropdown__tech">{{ selectedModel.model }}</span>
        {{ selectedModel.name }}
      </span>
      <span v-else class="text-body-secondary">{{ $t('modelSelect.placeholder') }}</span>
      <span v-if="loading" class="spinner-border spinner-border-sm" />
    </button>

    <!-- Dropdown (teleported to body for proper z-index) -->
    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="dropdownEl"
        class="csv-dropdown"
        :style="[dropdownStyle, { width: '360px' }]"
      >
        <!-- Search -->
        <div class="csv-dropdown__search">
          <input
            ref="searchInputEl"
            v-model="searchQuery"
            type="text"
            :placeholder="$t('modelSelect.searchPlaceholder')"
            class="form-control form-control-sm"
          />
        </div>

        <!-- Results -->
        <div class="csv-dropdown__results">
          <div
            v-if="filteredModels.length === 0"
            class="csv-dropdown__empty"
          >
            {{ $t('modelSelect.noResults') }}
          </div>

          <button
            v-for="model in filteredModels"
            :key="model.id"
            type="button"
            class="csv-dropdown__option"
            :class="{ 'csv-dropdown__option--selected': model.model === modelValue }"
            @click="selectModel(model)"
          >
            <span v-if="model.model === modelValue" class="csv-dropdown__check">&#10003;</span>
            <span v-else class="csv-dropdown__check" />
            <div class="csv-dropdown__option-text">
              <div>{{ model.name }}</div>
              <div class="csv-dropdown__tech">{{ model.model }}</div>
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
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  font-size: 0.875rem;
  text-align: left;
  background: var(--bs-body-bg);
  cursor: pointer;
  font-family: inherit;
}
.csv-model-select__trigger:focus-visible {
  outline: 2px solid var(--bs-primary);
  outline-offset: -1px;
}
.csv-model-select__trigger:disabled {
  background: var(--bs-tertiary-bg);
  cursor: not-allowed;
}
.csv-model-select__selected {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

