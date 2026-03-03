<script setup lang="ts">
import { ref, computed } from 'vue'
import { useDropdown } from '@/composables/useDropdown'
import '@/assets/csv-dropdown.css'

interface ProfileItem {
  id: number
  name: string
  version: string
  description?: string
}

const props = defineProps<{
  modelValue: number | null
  profiles: ProfileItem[]
  loading?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: number | null]
}>()

const searchQuery = ref('')
const searchInputEl = ref<HTMLInputElement | null>(null)

const {
  isOpen,
  triggerRef,
  dropdownRef,
  dropdownStyle,
  toggle,
  close
} = useDropdown({
  dropdownHeight: 320,
  dropdownWidth: 400,
  minSpaceBelow: 200,
  onOpen: () => {
    searchQuery.value = ''
    setTimeout(() => searchInputEl.value?.focus(), 50)
  }
})

const filteredProfiles = computed(() => {
  if (!searchQuery.value) return props.profiles
  const q = searchQuery.value.toLowerCase()
  return props.profiles.filter(p =>
    p.name.toLowerCase().includes(q) ||
    p.description?.toLowerCase().includes(q)
  )
})

const selectedProfile = computed(() =>
  props.profiles.find(p => p.id === props.modelValue)
)

function toggleOpen() {
  if (props.disabled || props.loading) return
  toggle()
}

function selectProfile(profile: ProfileItem | null) {
  emit('update:modelValue', profile?.id ?? null)
  close()
}
</script>

<template>
  <div ref="triggerRef" class="csv-profile-select">
    <!-- Trigger styled like file cards -->
    <button
      type="button"
      class="csv-profile-select__trigger"
      :class="{ 'csv-profile-select__trigger--selected': selectedProfile }"
      :disabled="disabled || loading"
      aria-haspopup="listbox"
      :aria-expanded="isOpen"
      @click="toggleOpen"
    >
      <div class="csv-profile-select__content">
        <div v-if="loading" class="csv-profile-select__loading">
          <span class="spinner-border spinner-border-sm" />
          {{ $t('config.loadingProfiles') }}
        </div>
        <template v-else-if="selectedProfile">
          <div class="csv-profile-select__name">
            {{ selectedProfile.name }}
          </div>
          <div class="csv-profile-select__meta">
            v{{ selectedProfile.version }}
            <span v-if="selectedProfile.description" class="csv-profile-select__desc">
              · {{ selectedProfile.description }}
            </span>
          </div>
        </template>
        <div v-else class="csv-profile-select__placeholder">
          {{ profiles.length === 0 ? $t('config.noProfiles') : $t('config.noProfileSelected') }}
        </div>
      </div>
      <svg class="csv-profile-select__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>

    <!-- Dropdown -->
    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="dropdownRef"
        class="csv-dropdown"
        :style="[dropdownStyle, { width: '400px' }]"
      >
        <!-- Search -->
        <div class="csv-dropdown__search">
          <input
            ref="searchInputEl"
            v-model="searchQuery"
            type="text"
            :placeholder="$t('profileSelect.searchPlaceholder')"
            class="form-control form-control-sm"
          />
        </div>

        <!-- Results -->
        <div class="csv-dropdown__results">
          <!-- No profile option -->
          <button
            type="button"
            class="csv-dropdown__option csv-profile-select__option-bordered"
            :class="{ 'csv-dropdown__option--selected': !modelValue }"
            @click="selectProfile(null)"
          >
            <span class="csv-dropdown__check">{{ !modelValue ? '✓' : '' }}</span>
            <div class="csv-dropdown__option-text">
              <div class="csv-profile-select__option-name text-body-secondary">
                {{ $t('config.noProfileSelected') }}
              </div>
            </div>
          </button>

          <div
            v-if="filteredProfiles.length === 0 && searchQuery"
            class="csv-dropdown__empty"
          >
            {{ $t('profileSelect.noResults') }}
          </div>

          <button
            v-for="profile in filteredProfiles"
            :key="profile.id"
            type="button"
            class="csv-dropdown__option csv-profile-select__option-bordered"
            :class="{ 'csv-dropdown__option--selected': profile.id === modelValue }"
            @click="selectProfile(profile)"
          >
            <span class="csv-dropdown__check">{{ profile.id === modelValue ? '✓' : '' }}</span>
            <div class="csv-dropdown__option-text">
              <div class="csv-profile-select__option-name">
                {{ profile.name }}
              </div>
              <div class="csv-profile-select__option-meta">
                v{{ profile.version }}
                <span v-if="profile.description" class="csv-profile-select__option-desc">
                  · {{ profile.description }}
                </span>
              </div>
            </div>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.csv-profile-select {
  position: relative;
}

.csv-profile-select__trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  background: var(--bs-body-bg);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.csv-profile-select__trigger:hover:not(:disabled) {
  border-color: var(--bs-secondary-color);
  background: var(--bs-tertiary-bg);
}

.csv-profile-select__trigger--selected {
  border-color: var(--bs-primary);
  background: var(--bs-primary-bg-subtle);
}

.csv-profile-select__trigger--selected:hover:not(:disabled) {
  border-color: var(--bs-primary);
  background: var(--bs-primary-bg-subtle);
}

.csv-profile-select__trigger:focus-visible {
  outline: 2px solid var(--bs-primary);
  outline-offset: -1px;
}

.csv-profile-select__trigger:disabled {
  background: var(--bs-tertiary-bg);
  cursor: not-allowed;
  opacity: 0.6;
}

.csv-profile-select__content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.csv-profile-select__loading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--bs-secondary-color);
}

.csv-profile-select__name {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--bs-body-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.csv-profile-select__meta {
  font-size: 0.75rem;
  color: var(--bs-secondary-color);
  margin-top: 0.125rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.csv-profile-select__desc {
  color: var(--bs-tertiary-color);
}

.csv-profile-select__placeholder {
  font-size: 0.875rem;
  color: var(--bs-tertiary-color);
}

.csv-profile-select__chevron {
  flex-shrink: 0;
  width: 1.25rem;
  height: 1.25rem;
  color: var(--bs-secondary-color);
}
</style>

<!-- Component-specific global styles (for teleported content) -->
<style>
.csv-profile-select__option-bordered {
  align-items: flex-start;
  padding: 0.625rem 0.75rem;
  border-bottom: 1px solid var(--bs-border-color-translucent);
}
.csv-profile-select__option-bordered:last-child {
  border-bottom: none;
}

.csv-profile-select__option-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--bs-body-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.csv-profile-select__option-meta {
  font-size: 0.75rem;
  color: var(--bs-secondary-color);
  margin-top: 0.125rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.csv-profile-select__option-desc {
  color: var(--bs-tertiary-color);
}
</style>
