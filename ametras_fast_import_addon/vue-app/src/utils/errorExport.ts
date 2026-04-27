export interface ErrorLogExportEntry {
  filename: string
  rowNumber: number
  error: string
  timestamp: number
  rawData?: Record<string, string>
}

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

export function buildUnifiedErrorLogCsv(errors: ErrorLogExportEntry[]): string {
  const headers = ['filename', 'row_number', 'error', 'timestamp', 'raw_data_json']
  const lines = [headers.join(',')]

  for (const error of errors) {
    const timestampIso = Number.isFinite(error.timestamp) && error.timestamp > 0
      ? new Date(error.timestamp).toISOString()
      : ''
    const rawDataJson = error.rawData && Object.keys(error.rawData).length > 0
      ? JSON.stringify(error.rawData)
      : ''

    lines.push([
      csvCell(error.filename),
      csvCell(error.rowNumber),
      csvCell(error.error),
      csvCell(timestampIso),
      csvCell(rawDataJson),
    ].join(','))
  }

  return lines.join('\n')
}

export function groupRowErrorsByFile(errors: ErrorLogExportEntry[]): Map<string, Map<number, string[]>> {
  const grouped = new Map<string, Map<number, string[]>>()

  for (const error of errors) {
    if (error.rowNumber <= 0) continue

    if (!grouped.has(error.filename)) {
      grouped.set(error.filename, new Map())
    }
    const rowMap = grouped.get(error.filename)!
    if (!rowMap.has(error.rowNumber)) {
      rowMap.set(error.rowNumber, [])
    }
    rowMap.get(error.rowNumber)!.push(error.error)
  }

  return grouped
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
