import { describe, it, expect } from 'vitest'
import { detectIdColumn } from '@/importer/batchExecutor'

describe('detectIdColumn', () => {
  it('detects external id when id is mapped to id', () => {
    const fieldMappings = { 'id': 'id', 'name': 'name' }
    expect(detectIdColumn(fieldMappings)).toBe('id')
  })

  it('detects database id when .id is mapped to .id', () => {
    const fieldMappings = { '.id': '.id', 'name': 'name' }
    expect(detectIdColumn(fieldMappings)).toBe('.id')
  })

  it('returns null when no id column is mapped', () => {
    const fieldMappings = { 'name': 'name', 'email': 'email' }
    expect(detectIdColumn(fieldMappings)).toBeNull()
  })

  it('prefers external id when both id and .id are mapped', () => {
    const fieldMappings = { 'id': 'id', '.id': '.id', 'name': 'name' }
    expect(detectIdColumn(fieldMappings)).toBe('id')
  })

  it('ignores id column mapped to something else', () => {
    const fieldMappings = { 'id': 'ref', 'name': 'name' }
    expect(detectIdColumn(fieldMappings)).toBeNull()
  })

  it('handles empty fieldMappings', () => {
    expect(detectIdColumn({})).toBeNull()
  })

  it('ignores relational id columns (country_id/id)', () => {
    const fieldMappings = { 'country_id/id': 'country_id/id', 'name': 'name' }
    expect(detectIdColumn(fieldMappings)).toBeNull()
  })

  it('detects id even with relational id columns present', () => {
    const fieldMappings = { 'id': 'id', 'country_id/id': 'country_id/id', 'name': 'name' }
    expect(detectIdColumn(fieldMappings)).toBe('id')
  })

  it('detects external id when any CSV column is mapped to id', () => {
    const fieldMappings = { 'external_id': 'id', 'name': 'name' }
    expect(detectIdColumn(fieldMappings)).toBe('id')
  })

  it('detects database id when any CSV column is mapped to .id', () => {
    const fieldMappings = { 'db_id': '.id', 'name': 'name' }
    expect(detectIdColumn(fieldMappings)).toBe('.id')
  })
})
