/**
 * Shared string similarity utilities for smart mapping.
 */

/**
 * Calculate the Levenshtein distance between two strings.
 * Returns the minimum number of single-character edits needed.
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

/**
 * Normalize a string for comparison by lowercasing and removing separators.
 */
export function normalizeForComparison(str: string): string {
  return str.toLowerCase().replace(/[-_\s.]/g, '')
}

/**
 * Tokenize a string into words by splitting on common separators.
 */
export function tokenize(str: string): string[] {
  return str
    .toLowerCase()
    .replace(/[-_.]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0)
}

/**
 * Simple English depluralization: strip common plural suffixes.
 */
export function depluralize(word: string): string {
  if (word.length <= 3) return word
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y'   // categories → category
  if (word.endsWith('ses')) return word.slice(0, -2)          // addresses → address
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)  // partners → partner
  return word
}
