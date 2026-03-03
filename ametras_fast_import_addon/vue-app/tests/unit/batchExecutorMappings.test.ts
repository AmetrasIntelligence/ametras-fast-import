import { describe, it, expect } from 'vitest'
import { detectIdColumn } from '@/importer/batchExecutor'

describe('detectIdColumn', () => {
  it('detects id columns across all mapping patterns', () => {
    const cases: [Record<string, string>, string | null][] = [
      [{ 'id': 'id', 'name': 'name' }, 'id'],
      [{ '.id': '.id', 'name': 'name' }, '.id'],
      [{ 'name': 'name', 'email': 'email' }, null],
      [{ 'id': 'id', '.id': '.id', 'name': 'name' }, 'id'],
      [{ 'id': 'ref', 'name': 'name' }, null],
      [{}, null],
      [{ 'country_id/id': 'country_id/id', 'name': 'name' }, null],
      [{ 'id': 'id', 'country_id/id': 'country_id/id', 'name': 'name' }, 'id'],
      [{ 'external_id': 'id', 'name': 'name' }, 'id'],
      [{ 'db_id': '.id', 'name': 'name' }, '.id'],
    ]
    for (const [fieldMappings, expected] of cases) {
      expect(detectIdColumn(fieldMappings)).toBe(expected)
    }
  })
})
