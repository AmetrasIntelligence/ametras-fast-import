import { describe, it, expect, beforeEach } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useDropdown } from '@/composables/useDropdown'

const TestDropdownHost = defineComponent({
  setup() {
    return useDropdown()
  },
  template: `
    <div>
      <button id="trigger" ref="triggerRef" type="button">Trigger</button>
      <div id="dropdown" ref="dropdownRef">
        <div id="inside-scroll-target">Inside</div>
      </div>
    </div>
  `
})

describe('useDropdown', () => {
  beforeEach(() => {
    Object.assign(window, {
      innerHeight: 900,
      innerWidth: 1200,
    })
  })

  it('does not close when scrolling inside dropdown, but closes on outside scroll', async () => {
    const wrapper = mount(TestDropdownHost, { attachTo: document.body })

    const triggerEl = wrapper.get('#trigger').element as HTMLElement
    Object.defineProperty(triggerEl, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 120,
        left: 180,
        bottom: 152,
        right: 320,
        width: 140,
        height: 32,
        x: 180,
        y: 120,
        toJSON: () => ({})
      })
    })

    const vm = wrapper.vm as any
    vm.open()
    await nextTick()
    expect(vm.isOpen).toBe(true)

    const insideScrollTarget = wrapper.get('#inside-scroll-target').element
    insideScrollTarget.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(vm.isOpen).toBe(true)

    document.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(vm.isOpen).toBe(false)

    wrapper.unmount()
  })
})
