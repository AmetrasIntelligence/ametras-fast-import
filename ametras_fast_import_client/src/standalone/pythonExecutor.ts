/**
 * Python subprocess availability check for the standalone (Electron) client.
 * Falls back to standalone model.load() mode if Python is unavailable.
 */

let pythonChecked = false
let pythonAvailable = false

/**
 * Check if Python import engine is available.
 * Caches the result after first check.
 */
export async function isPythonAvailable(): Promise<boolean> {
  if (pythonChecked) return pythonAvailable

  try {
    const result = await window.api.python.detect()
    pythonAvailable = result.available
    pythonChecked = true
    return pythonAvailable
  } catch {
    pythonAvailable = false
    pythonChecked = true
    return false
  }
}
