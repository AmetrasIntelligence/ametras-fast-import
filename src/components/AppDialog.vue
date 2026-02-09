<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useDialogState } from '@/composables/useDialog'
import { Button } from '@/ui'

const { state, updateInput, confirm, cancel } = useDialogState()
const inputEl = ref<HTMLInputElement | null>(null)

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
    <div
      v-if="state.open"
      class="csv-dialog-overlay"
      @keydown="handleKeydown"
      @click.self="cancel"
    >
      <div class="csv-dialog" role="dialog">
        <p class="csv-dialog__message">{{ state.message }}</p>

        <input
          v-if="state.type === 'prompt'"
          ref="inputEl"
          :value="state.inputValue"
          type="text"
          class="csv-dialog__input"
          @input="updateInput(($event.target as HTMLInputElement).value)"
          @keydown.enter="confirm"
        />

        <div class="csv-dialog__actions">
          <Button
            v-if="state.type !== 'alert'"
            variant="outline"
            size="sm"
            @click="cancel"
          >
            Cancel
          </Button>
          <Button size="sm" @click="confirm">
            OK
          </Button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.csv-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.csv-dialog {
  background: white;
  border-radius: var(--radius, 0.375rem);
  padding: 1.25rem;
  min-width: 320px;
  max-width: 480px;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
}
.csv-dialog__message {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  line-height: 1.5;
  white-space: pre-wrap;
}
.csv-dialog__input {
  width: 100%;
  height: 2rem;
  padding: 0 0.5rem;
  margin-bottom: 1rem;
  border: 1px solid #d1d5db;
  border-radius: var(--radius, 0.375rem);
  font-size: 0.875rem;
  font-family: inherit;
}
.csv-dialog__input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}
.csv-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
