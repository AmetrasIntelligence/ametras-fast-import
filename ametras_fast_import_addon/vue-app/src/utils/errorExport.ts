export interface FailedRowCsvEntry {
  rowNumber: number
  data: Record<string, string>
  error?: string
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function inferHeadersFromRows(rows: FailedRowCsvEntry[]): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row.data)) {
      if (seen.has(key)) continue
      seen.add(key)
      ordered.push(key)
    }
  }
  return ordered
}

export function buildFailedRowsCsv(
  headerOrder: string[],
  rows: FailedRowCsvEntry[],
): string {
  const effectiveHeaders = uniqueOrdered(
    headerOrder.length > 0 ? headerOrder : inferHeadersFromRows(rows)
  )
  const outputHeaders = [...effectiveHeaders, '__import_error__']
  const lines = [outputHeaders.map(csvCell).join(',')]

  const sortedRows = [...rows].sort((a, b) => a.rowNumber - b.rowNumber)
  for (const row of sortedRows) {
    const rowValues = effectiveHeaders.map((header) => csvCell(row.data[header] ?? ''))
    rowValues.push(csvCell(row.error ?? ''))
    lines.push(rowValues.join(','))
  }

  return lines.join('\n')
}
