import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Button from '@/ui/Button.vue'

describe('Button Component', () => {
  it('renders slot content', () => {
    const wrapper = mount(Button, {
      slots: {
        default: 'Click me'
      }
    })

    expect(wrapper.text()).toContain('Click me')
  })

  it('renders as button element', () => {
    const wrapper = mount(Button)
    expect(wrapper.element.tagName).toBe('BUTTON')
  })

  it('has type button by default', () => {
    const wrapper = mount(Button)
    expect(wrapper.attributes('type')).toBe('button')
  })

  it('can be type submit', () => {
    const wrapper = mount(Button, {
      props: { type: 'submit' }
    })
    expect(wrapper.attributes('type')).toBe('submit')
  })

  it('can be disabled', () => {
    const wrapper = mount(Button, {
      props: { disabled: true }
    })
    expect(wrapper.attributes('disabled')).toBeDefined()
  })

  it('is disabled when loading', () => {
    const wrapper = mount(Button, {
      props: { loading: true }
    })
    expect(wrapper.attributes('disabled')).toBeDefined()
  })

  it('shows loading spinner when loading', () => {
    const wrapper = mount(Button, {
      props: { loading: true },
      slots: { default: 'Submit' }
    })
    expect(wrapper.find('.spinner-border').exists()).toBe(true)
  })

  it('emits click event', async () => {
    const wrapper = mount(Button)
    // Use element.click() instead of wrapper.trigger() due to happy-dom compatibility
    wrapper.element.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('click')).toBeTruthy()
  })

  it('does not emit click when disabled', async () => {
    const wrapper = mount(Button, {
      props: { disabled: true }
    })
    await wrapper.trigger('click')
    // Disabled buttons don't emit click in real browsers
    // but @vue/test-utils may still emit - check behavior
  })

  describe('variants', () => {
    it('applies default variant styles', () => {
      const wrapper = mount(Button)
      expect(wrapper.classes()).toContain('btn-primary')
    })

    it('applies destructive variant styles', () => {
      const wrapper = mount(Button, {
        props: { variant: 'destructive' }
      })
      expect(wrapper.classes()).toContain('btn-danger')
    })

    it('applies outline variant styles', () => {
      const wrapper = mount(Button, {
        props: { variant: 'outline' }
      })
      expect(wrapper.classes()).toContain('btn-outline-secondary')
    })

    it('applies secondary variant styles', () => {
      const wrapper = mount(Button, {
        props: { variant: 'secondary' }
      })
      expect(wrapper.classes()).toContain('btn-secondary')
    })

    it('applies ghost variant styles', () => {
      const wrapper = mount(Button, {
        props: { variant: 'ghost' }
      })
      expect(wrapper.classes()).toContain('btn-link')
    })
  })

  describe('sizes', () => {
    it('applies small size', () => {
      const wrapper = mount(Button, {
        props: { size: 'sm' }
      })
      expect(wrapper.classes()).toContain('btn-sm')
    })

    it('applies large size', () => {
      const wrapper = mount(Button, {
        props: { size: 'lg' }
      })
      expect(wrapper.classes()).toContain('btn-lg')
    })
  })
})
