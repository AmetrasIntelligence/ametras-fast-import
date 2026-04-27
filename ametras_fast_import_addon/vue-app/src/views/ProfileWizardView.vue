<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProfilesStore } from '@/stores/profiles'
import { showAlert } from '@/composables/useDialog'
import type { ImportProfile } from '@/types/importProfile'
import { Button, Card } from '@/ui'
import ProfileWizardForm from '@/components/ProfileWizardForm.vue'

const { t } = useI18n()
const profiles = useProfilesStore()

const pageMode = ref<'create' | 'edit'>('create')
const selectedEditId = ref<number | null>(null)
const editProfile = ref<ImportProfile | null>(null)
const loadingEditProfile = ref(false)

const formKey = computed(() =>
  pageMode.value === 'create'
    ? 'create'
    : `edit-${selectedEditId.value ?? 'none'}`
)

onMounted(async () => {
  await profiles.loadProfiles(true)
})

watch(
  () => selectedEditId.value,
  async (id) => {
    if (pageMode.value !== 'edit' || id === null) {
      editProfile.value = null
      return
    }
    loadingEditProfile.value = true
    try {
      editProfile.value = await profiles.loadProfile(id)
    } catch (e) {
      editProfile.value = null
      await showAlert(t('profileWizard.failedToLoadEdit', { error: (e as Error).message }))
    } finally {
      loadingEditProfile.value = false
    }
  }
)

function setMode(mode: 'create' | 'edit') {
  pageMode.value = mode
  if (mode === 'create') {
    editProfile.value = null
    selectedEditId.value = null
  }
}

async function handleSaved(profile: ImportProfile) {
  profiles.invalidateCache()
  await profiles.loadProfiles(true)

  if (pageMode.value === 'create') {
    await showAlert(t('profileWizard.createdSuccess', { name: profile.name }))
  } else {
    await showAlert(t('profileWizard.updatedSuccess', { name: profile.name }))
  }
}
</script>

<template>
  <div class="p-4 d-flex flex-column gap-3">
    <div class="d-flex justify-content-between align-items-center">
      <h1 class="fs-4 fw-semibold mb-0">{{ $t('profileWizard.pageTitle') }}</h1>
      <div class="d-flex gap-2">
        <Button
          size="sm"
          :variant="pageMode === 'create' ? 'default' : 'outline'"
          @click="setMode('create')"
        >
          {{ $t('profileWizard.createTab') }}
        </Button>
        <Button
          size="sm"
          :variant="pageMode === 'edit' ? 'default' : 'outline'"
          @click="setMode('edit')"
        >
          {{ $t('profileWizard.editTab') }}
        </Button>
      </div>
    </div>

    <Card class="p-3">
      <div v-if="pageMode === 'edit'" class="mb-3">
        <label class="form-label small text-body-secondary mb-1">
          {{ $t('profileWizard.selectProfileToEdit') }}
        </label>
        <select
          class="form-select form-select-sm"
          :value="selectedEditId ?? ''"
          @change="selectedEditId = ($event.target as HTMLSelectElement).value ? parseInt(($event.target as HTMLSelectElement).value, 10) : null"
        >
          <option value="">{{ $t('profileWizard.chooseProfile') }}</option>
          <option
            v-for="profile in profiles.profileList"
            :key="profile.id"
            :value="profile.id"
          >
            {{ profile.name }} (v{{ profile.version }})
          </option>
        </select>
      </div>

      <div v-if="pageMode === 'edit' && selectedEditId === null" class="text-body-secondary small">
        {{ $t('profileWizard.selectEditHint') }}
      </div>

      <div v-else-if="loadingEditProfile" class="text-body-secondary small">
        {{ $t('common.loading') }}
      </div>

      <ProfileWizardForm
        v-else-if="pageMode === 'create' || editProfile"
        :key="formKey"
        :mode="pageMode"
        :edit-profile="editProfile"
        :allow-sample="false"
        @cancel="setMode('create')"
        @saved="handleSaved"
      />
    </Card>
  </div>
</template>
