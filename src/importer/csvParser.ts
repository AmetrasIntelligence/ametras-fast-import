import Papa from 'papaparse'

export interface ParsedRow {
  index: number
  data: Record<string, string>
  raw: string[]
}

export interface ParseOptions {
  delimiter?: string
  encoding?: string
  hasHeader?: boolean
}

/**
 * Parse CSV in streaming chunks - memory efficient for large files.
 * Yields batches of rows as they're parsed.
 */
export async function* parseCSVStream(
  fileId: string,
  batchSize: number,
  options: ParseOptions = {}
): AsyncGenerator<ParsedRow[], void, unknown> {
  const hasHeader = options.hasHeader ?? true
  let rowIndex = 0
  let batch: ParsedRow[] = []

  await window.api.files.streamChunks(fileId, batchSize + 1, (chunk) => {
    if (chunk.done || !chunk.data) return

    const parsed = Papa.parse(chunk.data, {
      delimiter: options.delimiter || '',
      header: hasHeader,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim()
    })

    for (const data of parsed.data as Record<string, string>[]) {
      rowIndex++
      batch.push({
        index: rowIndex,
        data,
        raw: Object.values(data)
      })
    }
  })

  // Yield final batch
  if (batch.length > 0) {
    yield batch
  }
}

/**
 * Parse CSV with callback per batch - better for async flow control.
 * Collects all rows synchronously during streaming, then processes
 * batches sequentially to avoid race conditions with concurrent callbacks.
 */
export async function parseCSVBatched(
  fileId: string,
  batchSize: number,
  onBatch: (rows: ParsedRow[]) => Promise<void>,
  options: ParseOptions = {}
): Promise<{ totalRows: number }> {
  const hasHeader = options.hasHeader ?? true
  let rowIndex = 0
  const allRows: ParsedRow[] = []

  // Phase 1: Collect all rows synchronously (no async in callback)
  await window.api.files.streamChunks(fileId, batchSize, (chunk) => {
    if (chunk.done || !chunk.data) return

    const parsed = Papa.parse(chunk.data, {
      delimiter: options.delimiter || '',
      header: hasHeader,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim()
    })

    for (const data of parsed.data as Record<string, string>[]) {
      rowIndex++
      allRows.push({ index: rowIndex, data, raw: Object.values(data) })
    }
  })

  // Phase 2: Process batches sequentially
  for (let i = 0; i < allRows.length; i += batchSize) {
    const batch = allRows.slice(i, i + batchSize)
    await onBatch(batch)
  }

  return { totalRows: rowIndex }
}

/**
 * Full file parse (for small files < 10MB).
 * Falls back to this for compatibility.
 */
export async function parseCSV(
  fileId: string,
  options: ParseOptions = {}
): Promise<ParsedRow[]> {
  const content = await window.api.files.read(fileId)
  const hasHeader = options.hasHeader ?? true

  const parsed = Papa.parse(content, {
    delimiter: options.delimiter || '',
    header: hasHeader,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim()
  })

  if (parsed.errors.length > 0) {
    console.warn('CSV parse warnings:', parsed.errors)
  }

  return parsed.data.map((data, index) => ({
    index: index + 1,
    data: data as Record<string, string>,
    raw: Object.values(data as Record<string, string>)
  }))
}

/**
 * Extract specific rows by their index from a CSV file.
 * Efficient for retry scenarios where only failed rows need to be re-processed.
 */
export async function extractRowsByIndex(
  fileId: string,
  targetIndices: Set<number>,
  options: ParseOptions = {}
): Promise<ParsedRow[]> {
  const hasHeader = options.hasHeader ?? true
  let rowIndex = 0
  const matchedRows: ParsedRow[] = []

  // Stream through file, collecting only matching rows
  await window.api.files.streamChunks(fileId, 1000, (chunk) => {
    if (chunk.done || !chunk.data) return

    const parsed = Papa.parse(chunk.data, {
      delimiter: options.delimiter || '',
      header: hasHeader,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim()
    })

    for (const data of parsed.data as Record<string, string>[]) {
      rowIndex++
      if (targetIndices.has(rowIndex)) {
        matchedRows.push({
          index: rowIndex,
          data,
          raw: Object.values(data)
        })
      }
    }
  })

  return matchedRows
}

/**
 * Analyze CSV structure using only first 10KB - memory efficient.
 */
export async function analyzeCSV(fileId: string): Promise<{
  headers: string[]
  rowCount: number
  sampleRows: Record<string, string>[]
  delimiter: string
  hasIdColumn: boolean
  hasDotIdColumn: boolean
}> {
  // Read only first 10KB for analysis
  const sample = await window.api.files.readHead(fileId, 10240)

  const parsed = Papa.parse(sample, {
    header: true,
    skipEmptyLines: true,
    preview: 5
  })

  const headers = parsed.meta.fields || []

  // Count lines efficiently via streaming
  const lineCount = await window.api.files.countLines(fileId)

  return {
    headers,
    rowCount: Math.max(0, lineCount - 1), // Subtract header
    sampleRows: parsed.data as Record<string, string>[],
    delimiter: parsed.meta.delimiter,
    hasIdColumn: headers.includes('id'),
    hasDotIdColumn: headers.includes('.id')
  }
}
