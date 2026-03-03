import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Progress from '@/ui/Progress.vue'

describe('Progress Component', () => {
  it('renders correct width for all value ranges', () => {
    const cases: [object, string][] = [
      [{ value: 0 }, '0%'],
      [{ value: 75 }, '75%'],
      [{ value: 100 }, '100%'],
      [{ value: 150 }, '100%'],
      [{ value: -10 }, '0%'],
      [{ value: 25, max: 50 }, '50%'],
    ]
    for (const [props, expectedWidth] of cases) {
      const wrapper = mount(Progress, { props })
      expect(wrapper.find('.progress').exists()).toBe(true)
      expect(wrapper.find('.progress-bar').attributes('style')).toContain(`width: ${expectedWidth}`)
    }
  })

  it('shows/hides label', () => {
    const withLabel = mount(Progress, { props: { value: 75, showLabel: true } })
    expect(withLabel.find('small').exists()).toBe(true)
    expect(withLabel.text()).toContain('75%')

    const noLabel = mount(Progress, { props: { value: 75 } })
    expect(noLabel.find('small').exists()).toBe(false)
  })

  it('applies all sizes', () => {
    const cases: [object, string][] = [
      [{ value: 50, size: 'sm' }, '0.25rem'],
      [{ value: 50 }, '0.5rem'],
      [{ value: 50, size: 'lg' }, '1rem'],
    ]
    for (const [props, expectedHeight] of cases) {
      const wrapper = mount(Progress, { props })
      expect(wrapper.find('.progress').attributes('style')).toContain(`height: ${expectedHeight}`)
    }
  })
})
