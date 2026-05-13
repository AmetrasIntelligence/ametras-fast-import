import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ImportSettings from '@/components/ImportSettings.vue'
import { useSessionStore } from '@/stores/session'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: vi.fn(),
}))

function makeWrapper(embedded: boolean) {
  setActivePinia(createPinia())
  const session = useSessionStore()
  if (embedded) {
    session.setEmbeddedMode({ uid: 1, baseUrl: '', db: 'test' })
  }
  return mount(ImportSettings, {
    global: {
      mocks: { $t: (key: string) => key }
    }
  })
}

describe('ImportSettings', () => {
  it('shows workers field in standalone mode', () => {
    const wrapper = makeWrapper(false)
    // workers i18n key appears in the label
    expect(wrapper.html()).toContain('settings.workers')
  })

  it('hides workers field completely in embedded mode', () => {
    const wrapper = makeWrapper(true)
    expect(wrapper.html()).not.toContain('settings.workers')
    // Batch size field is still shown
    expect(wrapper.html()).toContain('settings.batchSize')
  })
})
