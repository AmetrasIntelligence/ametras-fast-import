<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  limitations: string[]
}>()

const dismissed = ref(false)

function dismiss() {
  dismissed.value = true
}
</script>

<template>
  <div v-if="!dismissed" class="alert alert-warning rounded-0 mb-0 py-2 d-flex align-items-center justify-content-between">
    <div class="d-flex align-items-center gap-2">
      <span>⚠️</span>
      <div class="d-flex flex-column">
        <strong>{{ $t('standalone.title') }}</strong>
        <small class="opacity-75">
          {{ $t('standalone.description') }}
        </small>
      </div>
    </div>
    <button
      type="button"
      class="btn-close"
      :title="$t('common.dismiss')"
      @click="dismiss"
    ></button>
  </div>
</template>
