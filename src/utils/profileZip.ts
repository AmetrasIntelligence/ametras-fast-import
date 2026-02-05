import JSZip from 'jszip'

const REQUIRED_FILES = ['profile.csv', 'mappings.csv', 'sequence.csv']

/**
 * Import a profile from a ZIP file.
 * Extracts CSV files and returns them as a Record<filename, content>.
 */
export async function importProfileFromZip(file: File): Promise<Record<string, string>> {
  const arrayBuffer = await file.arrayBuffer()
  const zip = await JSZip.loadAsync(arrayBuffer)

  const csvFiles: Record<string, string> = {}

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    // Only process CSV files at root level
    const basename = name.split('/').pop() || name
    if (basename.endsWith('.csv')) {
      csvFiles[basename] = await entry.async('string')
    }
  }

  // Validate required files
  for (const required of REQUIRED_FILES) {
    if (!csvFiles[required]) {
      throw new Error(`Missing required file in ZIP: ${required}`)
    }
  }

  return csvFiles
}

/**
 * Export profile CSV files as a ZIP blob.
 */
export async function exportProfileToZip(
  csvFiles: Record<string, string>,
  _profileName: string
): Promise<Blob> {
  const zip = new JSZip()

  for (const [filename, content] of Object.entries(csvFiles)) {
    zip.file(filename, content)
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  return blob
}

/**
 * Trigger a download of a Blob as a file.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
