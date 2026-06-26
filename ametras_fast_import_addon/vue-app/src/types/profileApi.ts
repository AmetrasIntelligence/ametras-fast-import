/**
 * Wire-format types for the Odoo `/ametras_fast_import/profile/*` endpoints
 * and the Electron `window.api.profile.upload` IPC bridge.
 *
 * Domain types live in `types/importProfile.ts` — these mirror the snake_case,
 * stringly-typed shape returned by Odoo and need conversion before consumption.
 */

export interface BackendFieldMapping {
  filename: string
  csvHeader?: string
  csvColumn?: string
  odooField: string
  required?: boolean
  transform?: string
  notes?: string
}

export interface ProfileListItem {
  id: number
  name: string
  version: string
  description: string
  odoo_min_version: string
  derived_from: string
  created_at: string
  updated_at: string
}

export interface ProfileFullData extends ProfileListItem {
  mappings: Array<{
    filename: string
    model: string
    searchKeys?: string[]
    strict?: boolean
  }>
  sequence: Array<{ order: number; filename: string; requires?: string[] }>
  run_settings: Record<string, string>
  field_mappings: BackendFieldMapping[]
}
