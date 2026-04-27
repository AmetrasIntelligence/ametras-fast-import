<script setup lang="ts">
import type { ImportProfile } from '@/types/importProfile'
import type { ProfileWizardSeed } from '@/types/profileWizard'
import ProfileWizardForm from '@/components/ProfileWizardForm.vue'

const props = withDefaults(defineProps<{
  open: boolean
  mode: 'create' | 'edit'
  editProfile?: ImportProfile | null
  sampleSeed?: ProfileWizardSeed | null
  allowSample?: boolean
  initialSource?: 'scratch' | 'sample' | 'clone'
  initialCloneProfileId?: number | null
}>(), {
  editProfile: null,
  sampleSeed: null,
  allowSample: false,
  initialSource: 'scratch',
  initialCloneProfileId: null
})

const emit = defineEmits<{
  close: []
  saved: [profile: ImportProfile]
}>()
</script>

<template>
  <Teleport to="body">
    <Transition name="csv-profile-wizard-fade">
      <div
        v-if="props.open"
        class="csv-profile-wizard-overlay"
        @click.self="emit('close')"
      >
        <div class="csv-profile-wizard card shadow-lg">
          <ProfileWizardForm
            :mode="props.mode"
            :edit-profile="props.editProfile"
            :sample-seed="props.sampleSeed"
            :allow-sample="props.allowSample"
            :initial-source="props.initialSource"
            :initial-clone-profile-id="props.initialCloneProfileId"
            @cancel="emit('close')"
            @saved="emit('saved', $event)"
          />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.csv-profile-wizard-fade-enter-active,
.csv-profile-wizard-fade-leave-active {
  transition: opacity 0.15s ease;
}

.csv-profile-wizard-fade-enter-from,
.csv-profile-wizard-fade-leave-to {
  opacity: 0;
}

.csv-profile-wizard-overlay {
  position: fixed;
  inset: 0;
  z-index: 1080;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  overflow-y: auto;
  padding: 2rem 1rem;
}

.csv-profile-wizard {
  width: min(1080px, 100%);
  max-height: calc(100vh - 4rem);
  overflow: auto;
  padding: 1rem;
}
</style>
