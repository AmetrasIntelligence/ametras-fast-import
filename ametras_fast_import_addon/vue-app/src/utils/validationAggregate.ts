import type { ValidationFileReport, ValidationResult } from '@/api/odooClient'

/**
 * Row numbers that FAILED the original import for a given file — excluded from
 * validation so only successfully-imported rows are checked (parity with the
 * embedded ValidationRunner's use of file_progress.failedIndices).
 */
export function failedRowNumbers(
  errors: Array<{ filename: string; rowNumber: number }>,
  filename: string,
): number[] {
  return errors
    .filter((e) => e.filename === filename && e.rowNumber > 0)
    .map((e) => e.rowNumber)
}

/**
 * Combine per-file validation reports (from the standalone engine, one call per
 * file) into a single ValidationResult with summed totals.
 */
export function aggregateValidation(
  reports: Array<{ filename: string; report: ValidationFileReport }>,
): ValidationResult {
  const agg: ValidationResult = {
    checked: 0,
    ok: 0,
    failedRows: 0,
    unvalidatable: 0,
    perFile: {},
  }
  for (const { filename, report } of reports) {
    agg.perFile[filename] = report
    agg.checked += report.checked
    agg.ok += report.ok
    agg.failedRows += report.failedRows
    agg.unvalidatable += report.unvalidatable?.length || 0
  }
  return agg
}
