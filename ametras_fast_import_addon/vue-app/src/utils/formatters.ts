import type { OdooField } from '@/api/odooClient'

/**
 * Format a field for display, showing name and type.
 * Example: "name (char, required)"
 */
export function formatField(field: OdooField): string {
  const parts = [field.name]
  const attrs: string[] = [field.type]

  if (field.required) attrs.push('required')
  if (field.readonly) attrs.push('readonly')

  if (attrs.length > 0) {
    parts.push(`(${attrs.join(', ')})`)
  }

  return parts.join(' ')
}

/**
 * Format a number with thousands separator.
 */
export function formatNumber(n: number): string {
  return n.toLocaleString()
}

/**
 * Format bytes to human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

/**
 * Format duration in milliseconds to human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`

  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  return `${minutes}m ${seconds}s`
}

/**
 * Truncate a string with ellipsis if too long.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.substring(0, maxLength - 3) + '...'
}

/**
 * Format an error message for display, extracting key info.
 */
export function formatErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    if ('message' in error) return String((error as Record<string, unknown>).message)
    if ('error' in error) return String((error as Record<string, unknown>).error)
  }
  return 'Unknown error'
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
