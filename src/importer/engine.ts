import { ImportStateMachine, ImportState } from './stateMachine'
import { parseCSVBatched, analyzeCSV, type ParsedRow, type ParseOptions } from './csvParser'
import { executeBatch } from './batchExecutor'
import { RetryQueue } from './retryQueue'
import { useConfigStore } from '@/stores/config'
import { useRunStore } from '@/stores/run'
import type { FileMapping } from '@/stores/config'

export interface ImportFile {
  id: string
  name: string
}

export class ImportEngine {
  private stateMachine = new ImportStateMachine()
  private retryQueue: RetryQueue
  private abortController: AbortController | null = null

  constructor() {
    const config = useConfigStore()
    this.retryQueue = new RetryQueue(config.settings.retryLimit)
  }

  async start(files: ImportFile[]): Promise<void> {
    const config = useConfigStore()
    const run = useRunStore()

    this.abortController = new AbortController()

    this.stateMachine.transition(ImportState.VALIDATING)
    run.setState(ImportState.VALIDATING)

    // Build parse options from config settings
    const parseOptions: ParseOptions = {
      delimiter: config.settings.delimiter || undefined,
      encoding: config.settings.encoding,
      hasHeader: config.settings.skipHeader
    }

    // Analyze files (streaming line count)
    const rowCounts = new Map<string, number>()
    for (const file of files) {
      const analysis = await analyzeCSV(file.id)
      rowCounts.set(file.name, analysis.rowCount)
    }

    run.initRun(config.importSequence, rowCounts, config.settings.dryRun)

    if (this.abortController?.signal.aborted) return

    if (!this.stateMachine.tryTransition(ImportState.RUNNING_FILE)) {
      return
    }
    run.setState(ImportState.RUNNING_FILE)

    for (const filename of config.importSequence) {
      if (this.abortController.signal.aborted) break

      const file = files.find(f => f.name === filename)
      if (!file) continue

      await this.processFile(file, parseOptions)
    }

    if (!this.abortController.signal.aborted) {
      if (this.stateMachine.tryTransition(ImportState.COMPLETED)) {
        run.setState(ImportState.COMPLETED)
      }
    }
  }

  private async processFile(file: ImportFile, parseOptions: ParseOptions = {}): Promise<void> {
    const config = useConfigStore()
    const run = useRunStore()

    const mapping = config.getFileMapping(file.name)
    if (!mapping) {
      throw new Error(`No mapping for file: ${file.name}`)
    }

    run.startFile(file.name)
    this.retryQueue.clear()

    // Stream CSV in batches - memory efficient
    await parseCSVBatched(
      file.id,
      config.settings.batchSize,
      async (batch) => {
        if (this.abortController?.signal.aborted) return

        await this.processBatch(file.name, batch, mapping)
      },
      parseOptions
    )

    // Final retry pass for any remaining failures
    if (!this.abortController?.signal.aborted) {
      await this.processRetries(file.name, mapping)
    }

    if (!this.abortController?.signal.aborted) {
      run.completeFile(file.name)
    }
  }

  private async processBatch(
    filename: string,
    batch: ParsedRow[],
    mapping: FileMapping
  ): Promise<void> {
    if (this.abortController?.signal.aborted) return

    const run = useRunStore()

    // Use tryTransition to avoid errors if state was reset due to abort
    if (!this.stateMachine.tryTransition(ImportState.RUNNING_BATCH)) {
      return
    }
    run.setState(ImportState.RUNNING_BATCH)

    const config = useConfigStore()
    const results = await executeBatch(mapping.model, batch, mapping, config.settings.dryRun)

    if (this.abortController?.signal.aborted) return

    let successCount = 0
    let failedCount = 0

    results.forEach((result, idx) => {
      if (result.ok) {
        successCount++
      } else {
        failedCount++
        run.addError({
          filename,
          rowNumber: batch[idx].index,
          rawData: batch[idx].data,
          error: result.error || 'Unknown error',
          timestamp: Date.now()
        })
      }
    })

    this.retryQueue.addFailedRows(batch, results)

    const currentFile = run.currentFile
    if (currentFile) {
      run.updateFileProgress(filename, {
        processedRows: currentFile.processedRows + batch.length,
        successCount: currentFile.successCount + successCount,
        failedCount: currentFile.failedCount + failedCount
      })
    }

    // Immediate retry for failed rows
    if (this.retryQueue.pendingCount > 0 && !this.abortController?.signal.aborted) {
      await this.processRetries(filename, mapping)
    }

    if (this.abortController?.signal.aborted) return

    // Use tryTransition to avoid errors if state was reset due to abort
    if (this.stateMachine.tryTransition(ImportState.RUNNING_FILE)) {
      run.setState(ImportState.RUNNING_FILE)
    }

    // Small delay between batches
    await this.delay(50)
  }

  private async processRetries(filename: string, mapping: FileMapping): Promise<void> {
    if (this.abortController?.signal.aborted) return

    const config = useConfigStore()
    const run = useRunStore()

    const retryable = this.retryQueue.getRetryableRows()
    if (retryable.length === 0) return

    // Use tryTransition to avoid errors if state was reset due to abort
    if (!this.stateMachine.tryTransition(ImportState.RETRYING)) {
      return
    }
    run.setState(ImportState.RETRYING)

    await this.delay(config.settings.retryDelayMs)

    if (this.abortController?.signal.aborted) return

    const rows = retryable.map(r => r.row)
    const results = await executeBatch(mapping.model, rows, mapping, config.settings.dryRun)

    if (this.abortController?.signal.aborted) return

    let successCount = 0

    results.forEach((result, idx) => {
      if (result.ok) {
        this.retryQueue.markSuccess(rows[idx].index)
        successCount++
      }
    })

    // Update success count from retries
    const currentFile = run.currentFile
    if (currentFile && successCount > 0) {
      run.updateFileProgress(filename, {
        successCount: currentFile.successCount + successCount,
        failedCount: currentFile.failedCount - successCount
      })
    }
  }

  pause(): void {
    if (this.stateMachine.canPause) {
      this.stateMachine.transition(ImportState.PAUSED)
      useRunStore().setState(ImportState.PAUSED)
    }
  }

  resume(): void {
    if (this.stateMachine.state === ImportState.PAUSED) {
      this.stateMachine.transition(ImportState.RUNNING_FILE)
      useRunStore().setState(ImportState.RUNNING_FILE)
    }
  }

  abort(): void {
    this.abortController?.abort()
    this.stateMachine.reset()
    useRunStore().reset()
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.abortController?.signal.aborted) {
        resolve()
        return
      }

      const timeout = setTimeout(resolve, ms)

      // Clean up if aborted during delay
      this.abortController?.signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
    })
  }

  get state(): ImportState {
    return this.stateMachine.state
  }

  getFailedRowsCSV(headers: string[]): string {
    return this.retryQueue.exportFailedCSV(headers)
  }
}
