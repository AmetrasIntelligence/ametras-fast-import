import { ImportState } from '@/types/importState'

/**
 * Pure helpers for the standalone import run outcome.
 *
 * These exist so the run loop (RunView.runPythonImport) can never again
 * silently drop files and report a misleading "completed, 0 imported,
 * 0 errors". They partition the sequence into runnable vs skipped files,
 * flag files that imported nothing despite having rows, and decide the final
 * run state / whether anything actually ran.
 */

export type SkipReason = 'file-missing' | 'no-mapping'

export interface RunnableFile {
  filename: string
  fileId: string
}

export interface SkippedFile {
  filename: string
  reason: SkipReason
}

export interface PartitionedFiles {
  runnable: RunnableFile[]
  skipped: SkippedFile[]
}

interface FileRef {
  id: string
  name: string
}

/**
 * Split the import sequence into files we can actually run (present on disk
 * AND with a field mapping) versus files that must be skipped, tagged with the
 * reason. The run loop uses this instead of a bare `continue`, so every skip is
 * visible to the user.
 */
export function partitionImportFiles(
  sequence: string[],
  files: readonly FileRef[],
  fileMappings: Record<string, unknown>
): PartitionedFiles {
  const runnable: RunnableFile[] = []
  const skipped: SkippedFile[] = []
  for (const filename of sequence) {
    const file = files.find((f) => f.name === filename)
    if (!file) {
      skipped.push({ filename, reason: 'file-missing' })
      continue
    }
    if (!fileMappings[filename]) {
      skipped.push({ filename, reason: 'no-mapping' })
      continue
    }
    runnable.push({ filename, fileId: file.id })
  }
  return { runnable, skipped }
}

/**
 * True when a file finished with zero imported AND zero failed rows even though
 * analysis expected rows — the tell-tale of a delimiter/encoding/mapping
 * mismatch that collapses every row to blank (which the engine skips silently).
 */
export function isSuspiciousZeroImport(
  success: number,
  failed: number,
  expectedRows: number
): boolean {
  return success === 0 && failed === 0 && expectedRows > 0
}

export interface OutcomeInput {
  /** Files that were actually handed to the import engine. */
  processedCount: number
  /** Files skipped (missing on disk or no mapping). */
  skippedCount: number
  totalFailed: number
  errorCount: number
  cancelled: boolean
}

export interface RunOutcome {
  state: ImportState
  /** True when the run did no work at all (every file was skipped). */
  nothingRan: boolean
}

/**
 * Decide the final run state. Crucially, a run where NOTHING was processed
 * (every file skipped) is a FAILURE, not a "completed with 0 rows" — that
 * distinction is the whole point of this fix.
 */
export function finalizeImportOutcome(input: OutcomeInput): RunOutcome {
  const nothingRan = input.processedCount === 0 && input.skippedCount > 0
  const failed =
    input.cancelled ||
    input.totalFailed > 0 ||
    input.errorCount > 0 ||
    nothingRan
  return {
    state: failed ? ImportState.FAILED : ImportState.COMPLETED,
    nothingRan
  }
}
