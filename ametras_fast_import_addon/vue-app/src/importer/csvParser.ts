import Papa from 'papaparse'
import { logger } from '@/utils/logger'

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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('Aborted')
  error.name = 'AbortError'
  throw error
}

/**
 * Build a standard Papa.parse config for header-based parsing.
 */
function buildParseConfig(options: ParseOptions = {}): Papa.ParseConfig {
  return {
    delimiter: options.delimiter || '',
    header: options.hasHeader ?? true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim()
  }
}

/**
 * Parse CSV with callback per batch - memory efficient streaming.
 * Uses async streaming with backpressure: each chunk is processed before
 * requesting the next, preventing memory buildup for large files.
 */
export async function parseCSVBatched(
  fileId: string,
  batchSize: number,
  onBatch: (rows: ParsedRow[]) => Promise<void>,
  options: ParseOptions = {},
  signal?: AbortSignal
): Promise<{ totalRows: number }> {
  let rowIndex = 0

  // Start async stream with backpressure support
  const streamId = await window.api.files.streamStart(
    fileId,
    batchSize,
    options.encoding,
    options.hasHeader ?? true
  )

  try {
    while (true) {
      throwIfAborted(signal)
      // Request next chunk - stream pauses until we're ready
      const chunk = await window.api.files.streamNext(streamId)
      throwIfAborted(signal)

      if (chunk.error) {
        throw new Error(chunk.error)
      }

      // Process data before checking done flag — the server sends
      // done=true on the LAST chunk that still contains data, so we
      // must process it before breaking out of the loop.
      if (chunk.data) {
        // Parse this chunk
        const parsed = Papa.parse(chunk.data, buildParseConfig(options))

        // Check for parse errors
        if (parsed.errors.length > 0) {
          for (const err of parsed.errors) {
            logger.csv.warn(`Parse error at row ${(err.row ?? -1) + rowIndex + 1}: ${err.message}`, {
              type: err.type,
              code: err.code,
              row: err.row
            })
          }
          // Abort on unrecoverable errors (e.g. delimiter detection failure)
          const critical = parsed.errors.find(e => e.type === 'Delimiter')
          if (critical) {
            throw new Error(`CSV parse error: ${critical.message}`)
          }
        }

        // Build batch from parsed rows
        const batch: ParsedRow[] = []
        for (const data of parsed.data as Record<string, string>[]) {
          rowIndex++
          batch.push({ index: rowIndex, data, raw: Object.values(data) })
        }

        // Process batch - backpressure: we won't request next chunk until done
        if (batch.length > 0) {
          throwIfAborted(signal)
          await onBatch(batch)
        }
      }

      if (chunk.done) {
        break
      }
    }
  } finally {
    // Ensure stream is closed even if error occurs
    await window.api.files.streamClose(streamId).catch(() => {})
  }

  return { totalRows: rowIndex }
}

/**
 * Full file parse (loads entire file into memory).
 * Only suitable for small files (< 10MB). Use parseCSVBatched for large files.
 */
export async function parseCSVFull(
  fileId: string,
  options: ParseOptions = {}
): Promise<ParsedRow[]> {
  const content = await window.api.files.read(fileId)

  const parsed = Papa.parse(content, buildParseConfig(options))

  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      logger.csv.warn(`Parse error at row ${err.row ?? '?'}: ${err.message}`, {
        type: err.type,
        code: err.code,
        row: err.row
      })
    }
    const critical = parsed.errors.find(e => e.type === 'Delimiter')
    if (critical) {
      throw new Error(`CSV parse error: ${critical.message}`)
    }
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
  options: ParseOptions = {},
  signal?: AbortSignal
): Promise<ParsedRow[]> {
  let rowIndex = 0
  const matchedRows: ParsedRow[] = []

  // Stream through file with backpressure so abort/skip can cancel extraction.
  const streamId = await window.api.files.streamStart(
    fileId,
    1000,
    options.encoding,
    options.hasHeader ?? true
  )
  try {
    while (true) {
      throwIfAborted(signal)

      const chunk = await window.api.files.streamNext(streamId)
      if (chunk.error) {
        throw new Error(chunk.error)
      }

      throwIfAborted(signal)

      if (chunk.data) {
        const parsed = Papa.parse(chunk.data, buildParseConfig(options))

        if (parsed.errors.length > 0) {
          for (const err of parsed.errors) {
            logger.csv.warn(`Parse error at row ${(err.row ?? -1) + rowIndex + 1}: ${err.message}`, {
              type: err.type,
              code: err.code,
              row: err.row
            })
          }
        }

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
      }

      if (chunk.done) break
    }
  } finally {
    await window.api.files.streamClose(streamId).catch(() => {})
  }

  return matchedRows
}

/**
 * Analyze CSV structure using only first 10KB - memory efficient.
 */
export async function analyzeCSV(fileId: string, options: ParseOptions = {}): Promise<{
  headers: string[]
  rowCount: number
  sampleRows: Record<string, string>[]
  delimiter: string
  hasIdColumn: boolean
  hasDotIdColumn: boolean
}> {
  // Read only first 10KB for analysis
  const sample = await window.api.files.readHead(fileId, 10240)
  const hasHeader = options.hasHeader ?? true

  const parsed = Papa.parse(sample, {
    header: hasHeader,
    skipEmptyLines: true,
    preview: 5
  })

  const headers = (parsed.meta.fields || []) as string[]

  // Count lines efficiently via streaming
  const lineCount = await window.api.files.countLines(fileId)

  return {
    headers,
    rowCount: hasHeader ? Math.max(0, lineCount - 1) : lineCount,
    sampleRows: parsed.data as Record<string, string>[],
    delimiter: parsed.meta.delimiter,
    hasIdColumn: headers.includes('id'),
    hasDotIdColumn: headers.includes('.id')
  }
}
