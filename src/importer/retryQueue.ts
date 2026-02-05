import type { ParsedRow } from './csvParser'
import type { BatchResult, RowState } from './batchExecutor'

export interface RetryableRow {
  row: ParsedRow
  state: RowState
}

export class RetryQueue {
  private queue: Map<number, RetryableRow> = new Map()
  private maxRetries: number

  constructor(maxRetries: number = 3) {
    this.maxRetries = maxRetries
  }

  addFailedRows(rows: ParsedRow[], results: BatchResult[]): void {
    results.forEach((result, idx) => {
      if (!result.ok) {
        const row = rows[idx]
        const existing = this.queue.get(row.index)

        this.queue.set(row.index, {
          row,
          state: {
            rowIndex: row.index,
            attempts: (existing?.state.attempts || 0) + 1,
            lastError: result.error,
            status: 'retrying'
          }
        })
      }
    })
  }

  getRetryableRows(): RetryableRow[] {
    return Array.from(this.queue.values())
      .filter(r => r.state.attempts < this.maxRetries)
  }

  getFailedRows(): RetryableRow[] {
    return Array.from(this.queue.values())
      .filter(r => r.state.attempts >= this.maxRetries)
  }

  markSuccess(rowIndex: number): void {
    this.queue.delete(rowIndex)
  }

  clear(): void {
    this.queue.clear()
  }

  get pendingCount(): number {
    return this.getRetryableRows().length
  }

  get failedCount(): number {
    return this.getFailedRows().length
  }

  exportFailedCSV(headers: string[]): string {
    const failed = this.getFailedRows()
    if (failed.length === 0) return ''

    const lines = [headers.join(',')]

    for (const { row } of failed) {
      const values = headers.map(h => {
        const val = row.data[h] || ''
        if (val.includes(',') || val.includes('"') || val.includes('\n')) {
          return `"${val.replace(/"/g, '""')}"`
        }
        return val
      })
      lines.push(values.join(','))
    }

    return lines.join('\n')
  }
}
