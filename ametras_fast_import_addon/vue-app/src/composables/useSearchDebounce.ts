import { ref, watch, onBeforeUnmount } from 'vue'

/**
 * Shared composable for debounced search queries.
 * Eliminates duplicated debounce logic across select components.
 */
export function useSearchDebounce(delayMs = 200) {
  const searchQuery = ref('')
  const debouncedQuery = ref('')
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  watch(searchQuery, (val) => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debouncedQuery.value = val
    }, delayMs)
  })

  function reset() {
    searchQuery.value = ''
    debouncedQuery.value = ''
  }

  onBeforeUnmount(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
  })

  return {
    searchQuery,
    debouncedQuery,
    reset
  }
}
