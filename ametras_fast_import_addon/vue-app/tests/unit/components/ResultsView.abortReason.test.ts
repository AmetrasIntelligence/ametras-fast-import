import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ResultsView from '@/views/ResultsView.vue'
import { useRunStore } from '@/stores/run'
import { ImportState } from '@/types/importState'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

function mountResults(abortReason: string | null, dryRun = false) {
  setActivePinia(createPinia())
  const run = useRunStore()
  run.initRun(['products.csv'], new Map([['products.csv', 16226]]), dryRun)
  if (abortReason) run.setAbortReason(abortReason)
  run.setState(ImportState.FAILED)
  return mount(ResultsView, {
    global: { mocks: { $t: (key: string) => key } },
  })
}

describe('ResultsView — run cancelled by the client', () => {
  it('says the import was cancelled and why, not that it completed', () => {
    const wrapper = mountResults('Simulated startup timeout: no sign of life for 90 s')
    const html = wrapper.html()

    expect(html).toContain('results.importCancelled')
    expect(html).not.toContain('results.importComplete')
    expect(html).toContain('Simulated startup timeout: no sign of life for 90 s')
  })

  it('drops the dry-run-complete banner when a dry run was cancelled', () => {
    const wrapper = mountResults('Simulated dry-run startup timeout', true)
    const html = wrapper.html()

    expect(html).toContain('Simulated dry-run startup timeout')
    expect(html).not.toContain('results.dryRunBanner')
    expect(html).not.toContain('results.dryRunComplete')
  })

  it('keeps the completed title when the run ended on its own', () => {
    const wrapper = mountResults(null)
    const html = wrapper.html()

    expect(html).toContain('results.importComplete')
    expect(html).not.toContain('results.importCancelled')
  })
})
