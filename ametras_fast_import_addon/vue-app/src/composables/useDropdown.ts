import { ref, watch, onBeforeUnmount } from 'vue'

export interface DropdownOptions {
  /** Estimated max height for positioning calculations */
  dropdownHeight?: number
  /** Estimated width for positioning calculations */
  dropdownWidth?: number
  /** Minimum space below trigger to prefer opening below (default: 150) */
  minSpaceBelow?: number
  /** Callback when dropdown opens */
  onOpen?: () => void
  /** Callback when dropdown closes */
  onClose?: () => void
}

/**
 * Shared dropdown/select composable for teleported dropdowns.
 * Handles positioning, click-outside detection, and lifecycle.
 */
export function useDropdown(options: DropdownOptions = {}) {
  const {
    dropdownHeight = 320,
    dropdownWidth = 360,
    minSpaceBelow = 150,
    onOpen,
    onClose
  } = options

  const isOpen = ref(false)
  const triggerRef = ref<HTMLElement | null>(null)
  const dropdownRef = ref<HTMLElement | null>(null)
  const dropdownStyle = ref<{ top: string; left: string; maxHeight?: string }>({ top: '0px', left: '0px' })

  function updatePosition() {
    if (!triggerRef.value) return
    const rect = triggerRef.value.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const spaceAbove = rect.top - 8

    const left = `${Math.max(8, Math.min(rect.left, window.innerWidth - dropdownWidth - 8))}px`

    // Prefer opening below unless there's truly not enough space
    // Only open above if space below is less than minSpaceBelow AND there's more space above
    if (spaceBelow >= minSpaceBelow || spaceBelow >= spaceAbove) {
      // Open below
      dropdownStyle.value = {
        top: `${rect.bottom + 4}px`,
        left,
        maxHeight: `${Math.min(spaceBelow, dropdownHeight)}px`
      }
    } else {
      // Open above
      const actualHeight = Math.min(spaceAbove, dropdownHeight)
      dropdownStyle.value = {
        top: `${rect.top - actualHeight - 4}px`,
        left,
        maxHeight: `${actualHeight}px`
      }
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (
      !triggerRef.value?.contains(e.target as Node) &&
      !dropdownRef.value?.contains(e.target as Node)
    ) {
      close()
    }
  }

  function open() {
    if (isOpen.value) return
    isOpen.value = true
    updatePosition()
    onOpen?.()
  }

  function close() {
    if (!isOpen.value) return
    isOpen.value = false
    onClose?.()
  }

  function toggle() {
    if (isOpen.value) {
      close()
    } else {
      open()
    }
  }

  function isEventInsideDropdown(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return false
    return Boolean(
      triggerRef.value?.contains(target) ||
      dropdownRef.value?.contains(target)
    )
  }

  // Close dropdown on outside scroll so it doesn't detach from the trigger.
  // Keep open when the user scrolls inside the dropdown list itself.
  function handleScroll(event: Event) {
    if (isEventInsideDropdown(event.target)) return
    close()
  }

  // Register/unregister click outside and scroll listeners
  watch(isOpen, (open) => {
    if (open) {
      document.addEventListener('click', handleClickOutside, true)
      document.addEventListener('scroll', handleScroll, true)
    } else {
      document.removeEventListener('click', handleClickOutside, true)
      document.removeEventListener('scroll', handleScroll, true)
    }
  })

  onBeforeUnmount(() => {
    document.removeEventListener('click', handleClickOutside, true)
    document.removeEventListener('scroll', handleScroll, true)
  })

  return {
    isOpen,
    triggerRef,
    dropdownRef,
    dropdownStyle,
    open,
    close,
    toggle,
    updatePosition
  }
}
