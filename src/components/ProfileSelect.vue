<script setup lang="ts">
import { ref, computed } from 'vue'
import { useDropdown } from '@/composables/useDropdown'

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
  <div class="csv-profile-select" ref="triggerRef">
    <!-- Trigger styled like file cards -->
    <button
      type="button"
      class="csv-profile-select__trigger"
      :class="{ 'csv-profile-select__trigger--selected': selectedProfile }"
      :disabled="disabled || loading"
      @click="toggleOpen"
    >
      <div class="csv-profile-select__content">
        <div v-if="loading" class="csv-profile-select__loading">
          <span class="csv-profile-select__spinner" />
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
        class="csv-profile-select__dropdown"
        :style="dropdownStyle"
      >
        <!-- Search -->
        <div class="csv-profile-select__search">
          <input
            ref="searchInputEl"
            v-model="searchQuery"
            type="text"
            :placeholder="$t('profileSelect.searchPlaceholder')"
            class="csv-profile-select__search-input"
          />
        </div>

        <!-- Results -->
        <div class="csv-profile-select__results">
          <!-- No profile option -->
          <button
            type="button"
            class="csv-profile-select__option"
            :class="{ 'csv-profile-select__option--selected': !modelValue }"
            @click="selectProfile(null)"
          >
            <span class="csv-profile-select__check">{{ !modelValue ? '✓' : '' }}</span>
            <div class="csv-profile-select__option-content">
              <div class="csv-profile-select__option-name csv-text-muted">
                {{ $t('config.noProfileSelected') }}
              </div>
            </div>
          </button>

          <div
            v-if="filteredProfiles.length === 0 && searchQuery"
            class="csv-profile-select__empty"
          >
            {{ $t('profileSelect.noResults') }}
          </div>

          <button
            v-for="profile in filteredProfiles"
            :key="profile.id"
            type="button"
            class="csv-profile-select__option"
            :class="{ 'csv-profile-select__option--selected': profile.id === modelValue }"
            @click="selectProfile(profile)"
          >
            <span class="csv-profile-select__check">{{ profile.id === modelValue ? '✓' : '' }}</span>
            <div class="csv-profile-select__option-content">
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
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  background: white;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.csv-profile-select__trigger:hover:not(:disabled) {
  border-color: #9ca3af;
  background: #fafafa;
}

.csv-profile-select__trigger--selected {
  border-color: #2563eb;
  background: #eff6ff;
}

.csv-profile-select__trigger--selected:hover:not(:disabled) {
  border-color: #1d4ed8;
  background: #dbeafe;
}

.csv-profile-select__trigger:disabled {
  background: #f3f4f6;
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
  color: #6b7280;
}

.csv-profile-select__spinner {
  width: 1rem;
  height: 1rem;
  border: 2px solid #e5e7eb;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: csv-spin 1s linear infinite;
}

.csv-profile-select__name {
  font-size: 0.875rem;
  font-weight: 500;
  color: #111827;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.csv-profile-select__meta {
  font-size: 0.75rem;
  color: #6b7280;
  margin-top: 0.125rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.csv-profile-select__desc {
  color: #9ca3af;
}

.csv-profile-select__placeholder {
  font-size: 0.875rem;
  color: #9ca3af;
}

.csv-profile-select__chevron {
  flex-shrink: 0;
  width: 1.25rem;
  height: 1.25rem;
  color: #9ca3af;
}

@keyframes csv-spin {
  to { transform: rotate(360deg); }
}
</style>

<!-- Global styles for teleported dropdown -->
<style>
.csv-profile-select__dropdown {
  position: fixed;
  z-index: 1000;
  width: 400px;
  max-width: calc(100vw - 2rem);
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  background: white;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1), 0 1px 3px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.csv-profile-select__search {
  flex-shrink: 0;
  padding: 0.5rem;
  border-bottom: 1px solid #e5e7eb;
}

.csv-profile-select__search-input {
  width: 100%;
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.875rem;
  font-family: inherit;
}

.csv-profile-select__search-input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.csv-profile-select__results {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.csv-profile-select__empty {
  padding: 1rem;
  text-align: center;
  font-size: 0.875rem;
  color: #6b7280;
}

.csv-profile-select__option {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.625rem 0.75rem;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-family: inherit;
  border-bottom: 1px solid #f3f4f6;
}

.csv-profile-select__option:last-child {
  border-bottom: none;
}

.csv-profile-select__option:hover {
  background: #f3f4f6;
}

.csv-profile-select__option--selected {
  background: #eff6ff;
}

.csv-profile-select__check {
  width: 1rem;
  flex-shrink: 0;
  color: #2563eb;
  font-size: 0.875rem;
  padding-top: 0.125rem;
}

.csv-profile-select__option-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.csv-profile-select__option-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: #111827;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.csv-profile-select__option-meta {
  font-size: 0.75rem;
  color: #6b7280;
  margin-top: 0.125rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.csv-profile-select__option-desc {
  color: #9ca3af;
}
</style>
