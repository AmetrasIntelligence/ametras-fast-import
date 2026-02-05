import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Progress from '@/ui/Progress.vue'

describe('Progress Component', () => {
  it('renders progress bar', () => {
    const wrapper = mount(Progress, {
      props: { value: 50 }
    })

    expect(wrapper.find('.csv-progress-track').exists()).toBe(true)
    expect(wrapper.find('.csv-progress-bar').exists()).toBe(true)
  })

  it('sets correct width for value', () => {
    const wrapper = mount(Progress, {
      props: { value: 75 }
    })

    const bar = wrapper.find('.csv-progress-bar')
    expect(bar.attributes('style')).toContain('width: 75%')
  })

  it('handles 0%', () => {
    const wrapper = mount(Progress, {
      props: { value: 0 }
    })

    const bar = wrapper.find('.csv-progress-bar')
    expect(bar.attributes('style')).toContain('width: 0%')
  })

  it('handles 100%', () => {
    const wrapper = mount(Progress, {
      props: { value: 100 }
    })

    const bar = wrapper.find('.csv-progress-bar')
    expect(bar.attributes('style')).toContain('width: 100%')
  })

  it('clamps value over 100', () => {
    const wrapper = mount(Progress, {
      props: { value: 150 }
    })

    const bar = wrapper.find('.csv-progress-bar')
    expect(bar.attributes('style')).toContain('width: 100%')
  })

  it('clamps negative value', () => {
    const wrapper = mount(Progress, {
      props: { value: -10 }
    })

    const bar = wrapper.find('.csv-progress-bar')
    expect(bar.attributes('style')).toContain('width: 0%')
  })

  it('calculates percentage with custom max', () => {
    const wrapper = mount(Progress, {
      props: { value: 25, max: 50 }
    })

    const bar = wrapper.find('.csv-progress-bar')
    expect(bar.attributes('style')).toContain('width: 50%')
  })

  it('shows label when showLabel is true', () => {
    const wrapper = mount(Progress, {
      props: { value: 75, showLabel: true }
    })

    expect(wrapper.find('.csv-progress-label').exists()).toBe(true)
    expect(wrapper.text()).toContain('75%')
  })

  it('hides label by default', () => {
    const wrapper = mount(Progress, {
      props: { value: 75 }
    })

    expect(wrapper.find('.csv-progress-label').exists()).toBe(false)
  })

  describe('sizes', () => {
    it('applies small size', () => {
      const wrapper = mount(Progress, {
        props: { value: 50, size: 'sm' }
      })

      expect(wrapper.find('.csv-h-1').exists()).toBe(true)
    })

    it('applies medium size by default', () => {
      const wrapper = mount(Progress, {
        props: { value: 50 }
      })

      expect(wrapper.find('.csv-h-2').exists()).toBe(true)
    })

    it('applies large size', () => {
      const wrapper = mount(Progress, {
        props: { value: 50, size: 'lg' }
      })

      expect(wrapper.find('.csv-h-4').exists()).toBe(true)
    })
  })
})
