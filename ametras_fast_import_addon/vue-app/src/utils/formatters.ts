/**
 * Format a number with thousands separator.
 */
export function formatNumber(n: number): string {
  return n.toLocaleString()
}

/**
 * Format a timestamp to locale string.
 */
export function formatTimestamp(timestamp: number | string | Date): string {
  const date = typeof timestamp === 'number' ? new Date(timestamp) :
               typeof timestamp === 'string' ? new Date(timestamp) :
               timestamp
  return date.toLocaleString()
}

// ── Download utilities (merged from download.ts) ─────────────────────

/**
 * Trigger a browser file download from in-memory content.
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadCSV(content: string, filename: string): void {
  downloadFile(content, filename, 'text/csv')
}

export function downloadJSON(data: unknown, filename: string): void {
  downloadFile(JSON.stringify(data, null, 2), filename, 'application/json')
}
