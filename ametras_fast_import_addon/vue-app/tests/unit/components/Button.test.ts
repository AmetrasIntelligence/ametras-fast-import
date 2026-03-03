import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Button from '@/ui/Button.vue'

describe('Button Component', () => {
  it('renders with correct defaults and type', () => {
    const wrapper = mount(Button, { slots: { default: 'Click me' } })
    expect(wrapper.text()).toContain('Click me')
    expect(wrapper.element.tagName).toBe('BUTTON')
    expect(wrapper.attributes('type')).toBe('button')

    const submit = mount(Button, { props: { type: 'submit' } })
    expect(submit.attributes('type')).toBe('submit')
  })

  it('handles disabled and loading states', () => {
    const disabled = mount(Button, { props: { disabled: true } })
    expect(disabled.attributes('disabled')).toBeDefined()

    const loading = mount(Button, { props: { loading: true }, slots: { default: 'Submit' } })
    expect(loading.attributes('disabled')).toBeDefined()
    expect(loading.find('.spinner-border').exists()).toBe(true)
  })

  it('emits click event', async () => {
    const wrapper = mount(Button)
    wrapper.element.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('click')).toBeTruthy()
  })

  it('applies all variant styles', () => {
    const cases: [string | undefined, string][] = [
      [undefined, 'btn-primary'],
      ['destructive', 'btn-danger'],
      ['outline', 'btn-outline-secondary'],
      ['secondary', 'btn-secondary'],
      ['ghost', 'btn-link'],
    ]
    for (const [variant, expectedClass] of cases) {
      const wrapper = mount(Button, { props: variant ? { variant } : {} })
      expect(wrapper.classes()).toContain(expectedClass)
    }
  })

  it('applies all size styles', () => {
    for (const [size, cls] of [['sm', 'btn-sm'], ['lg', 'btn-lg']] as const) {
      const wrapper = mount(Button, { props: { size } })
      expect(wrapper.classes()).toContain(cls)
    }
  })
})
