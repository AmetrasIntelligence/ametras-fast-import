<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useDialogState } from '@/composables/useDialog'
import { useI18n } from 'vue-i18n'
import { Button } from '@/ui'

const { t } = useI18n()
const { state, updateInput, confirm, cancel } = useDialogState()
const inputEl = ref<HTMLInputElement | null>(null)

const dialogTitle = computed(() => {
  switch (state.value.type) {
    case 'alert': return t('dialogs.alert')
    case 'confirm': return t('dialogs.confirm')
    case 'prompt': return t('dialogs.prompt')
    default: return ''
  }
})

const dialogIconPath = computed(() => {
  switch (state.value.type) {
    // Info circle
    case 'alert': return 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z'
    // Question/warning triangle
    case 'confirm': return 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'
    // Pencil edit
    case 'prompt': return 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z'
    default: return ''
  }
})

watch(() => state.value.open, async (open) => {
  if (open && state.value.type === 'prompt') {
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select()
  }
})

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    confirm()
  } else if (e.key === 'Escape') {
    cancel()
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="csv-dialog-fade">
      <div
        v-if="state.open"
        class="csv-dialog-overlay"
        @keydown="handleKeydown"
        @click.self="cancel"
      >
        <div class="csv-dialog card shadow-lg" :class="`csv-dialog--${state.type}`" role="dialog">
          <div class="csv-dialog__header">
            <span class="csv-dialog__icon" :class="`csv-dialog__icon--${state.type}`">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path :d="dialogIconPath" /></svg>
            </span>
            <span class="csv-dialog__title">{{ dialogTitle }}</span>
          </div>

          <p class="csv-dialog__message">{{ state.message }}</p>

          <input
            v-if="state.type === 'prompt'"
            ref="inputEl"
            :value="state.inputValue"
            type="text"
            class="form-control form-control-sm mb-3"
            @input="updateInput(($event.target as HTMLInputElement).value)"
            @keydown.enter="confirm"
          />

          <div class="d-flex justify-content-end gap-2 pt-2">
            <Button
              v-if="state.type !== 'alert'"
              variant="outline"
              size="sm"
              @click="cancel"
            >
              {{ t('common.cancel') }}
            </Button>
            <Button size="sm" @click="confirm">
              {{ t('common.ok') }}
            </Button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Transition animations */
.csv-dialog-fade-enter-active,
.csv-dialog-fade-leave-active {
  transition: opacity 0.15s ease;
}
.csv-dialog-fade-enter-active .csv-dialog,
.csv-dialog-fade-leave-active .csv-dialog {
  transition: transform 0.15s ease, opacity 0.15s ease;
}
.csv-dialog-fade-enter-from,
.csv-dialog-fade-leave-to {
  opacity: 0;
}
.csv-dialog-fade-enter-from .csv-dialog,
.csv-dialog-fade-leave-to .csv-dialog {
  transform: scale(0.95);
  opacity: 0;
}

.csv-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 1050;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}

.csv-dialog {
  padding: 1.5rem;
  min-width: 360px;
  max-width: 480px;
}

.csv-dialog__header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--bs-border-color-translucent);
}

.csv-dialog__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  flex-shrink: 0;
}

.csv-dialog__icon--alert {
  background: var(--bs-primary-bg-subtle);
  color: var(--bs-primary);
}

.csv-dialog__icon--confirm {
  background: var(--bs-warning-bg-subtle);
  color: var(--bs-warning-text-emphasis);
}

.csv-dialog__icon--prompt {
  background: var(--bs-info-bg-subtle);
  color: var(--bs-info-text-emphasis);
}

.csv-dialog__title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--bs-body-color);
}

.csv-dialog__message {
  margin: 0 0 1.25rem;
  font-size: 0.875rem;
  font-family: inherit;
  line-height: 1.6;
  color: var(--bs-secondary-color);
  white-space: pre-wrap;
}
</style>
