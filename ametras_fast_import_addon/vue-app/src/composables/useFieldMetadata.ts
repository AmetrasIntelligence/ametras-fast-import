import { ref } from 'vue'
import { useConfigStore } from '@/stores/config'
import { fetchModelFields, type OdooField } from '@/api/odooClient'
import type { FieldMapping, FieldTransform } from '@/types/fieldMapping'

export function useFieldMetadata() {
  const config = useConfigStore()

  const fieldsCache = ref<Map<string, OdooField[]>>(new Map())
  const richFieldMappings = ref<Map<string, FieldMapping[]>>(new Map())
  const transformOverrides = ref<Map<string, FieldTransform>>(new Map())

  async function ensureFieldsCached(model: string) {
    if (!fieldsCache.value.has(model)) {
      const fields = await fetchModelFields(model)
      fieldsCache.value.set(model, fields)
    }
  }

  function getFieldsForFile(filename: string): OdooField[] {
    const mapping = config.getFileMapping(filename)
    if (!mapping?.model) return []
    return fieldsCache.value.get(mapping.model) || []
  }

  function getFieldLookup(filename: string): Map<string, OdooField> {
    const map = new Map<string, OdooField>()
    for (const f of getFieldsForFile(filename)) {
      map.set(f.name, f)
    }
    return map
  }

  function buildValidFieldValues(fields: OdooField[]): Set<string> {
    const valid = new Set<string>(['id', '.id'])
    for (const f of fields) {
      // Exclude computed non-stored fields: they can never be written.
      // Readonly stored fields (e.g. interface = Char readonly=True) are
      // valid targets — the backend writes them on update, skips on create.
      if (f.readonly && !f.store) continue
      valid.add(f.name)
      if (f.type === 'many2one' || f.type === 'many2many') {
        valid.add(`${f.name}/id`)
        valid.add(`${f.name}/.id`)
      }
    }
    return valid
  }

  function computeFieldMetadata(filename: string, csvHeader: string, odooField: string): { transform: FieldTransform; required: boolean } {
    const baseName = odooField.endsWith('/.id')
      ? odooField.slice(0, -4)
      : odooField.endsWith('/id')
        ? odooField.slice(0, -3)
        : odooField

    const fieldLookup = getFieldLookup(filename)
    const field = fieldLookup.get(baseName)
    const isRelational = field?.type === 'many2one' || field?.type === 'many2many'

    let transform: FieldTransform = { type: 'passthrough' }
    let required = field?.required ?? false

    if (odooField.endsWith('/id') && isRelational && field?.relation) {
      transform = field.type === 'many2many'
        ? { type: 'm2m_ref', model: field.relation }
        : { type: 'm2o_ref', model: field.relation }
    } else if (odooField.endsWith('/.id') && isRelational && field?.relation) {
      transform = { type: 'db_id', model: field.relation }
    }

    if (csvHeader === 'id' || odooField === 'id') {
      required = true
    }

    return { transform, required }
  }

  function updateRichMapping(filename: string, csvHeader: string, odooField: string) {
    const stored = richFieldMappings.value.get(filename) || []
    const idx = stored.findIndex(m => m.csvHeader === csvHeader)

    if (!odooField) {
      if (idx >= 0) {
        stored.splice(idx, 1)
        richFieldMappings.value.set(filename, stored)
      }
      transformOverrides.value.delete(`${filename}:${csvHeader}`)
      return
    }

    const { transform: autoTransform, required } = computeFieldMetadata(filename, csvHeader, odooField)
    const overrideKey = `${filename}:${csvHeader}`
    const transform = transformOverrides.value.get(overrideKey) ?? autoTransform

    const newMapping: FieldMapping = {
      filename,
      csvHeader,
      odooField,
      required,
      transform
    }

    if (idx >= 0) {
      stored[idx] = newMapping
    } else {
      stored.push(newMapping)
    }
    richFieldMappings.value.set(filename, stored)
  }

  function updateFieldMapping(filename: string, csvHeader: string, odooField: string) {
    const mapping = config.getFileMapping(filename)
    if (!mapping) return

    const fieldMappings = { ...mapping.fieldMappings }
    if (odooField) {
      fieldMappings[csvHeader] = odooField
    } else {
      delete fieldMappings[csvHeader]
    }
    config.setFileMapping(filename, { ...mapping, fieldMappings })
    updateRichMapping(filename, csvHeader, odooField)
  }

  function updateTransform(filename: string, csvHeader: string, transform: FieldTransform) {
    const overrideKey = `${filename}:${csvHeader}`
    transformOverrides.value.set(overrideKey, transform)
    updateRichMapping(filename, csvHeader, config.getFileMapping(filename)?.fieldMappings[csvHeader] || '')
  }

  function buildRichFieldMappings(filename: string, fieldMappingsRecord: Record<string, string>): FieldMapping[] {
    const result: FieldMapping[] = []
    for (const [csvHeader, odooField] of Object.entries(fieldMappingsRecord)) {
      const { transform, required } = computeFieldMetadata(filename, csvHeader, odooField)
      result.push({ filename, csvHeader, odooField, required, transform })
    }
    return result
  }

  function clearForFile(filename: string) {
    richFieldMappings.value.delete(filename)
    // Clear transform overrides for this file
    for (const key of transformOverrides.value.keys()) {
      if (key.startsWith(`${filename}:`)) {
        transformOverrides.value.delete(key)
      }
    }
  }

  function clearAll() {
    richFieldMappings.value = new Map()
    transformOverrides.value = new Map()
  }

  return {
    fieldsCache,
    richFieldMappings,
    transformOverrides,
    ensureFieldsCached,
    getFieldsForFile,
    getFieldLookup,
    buildValidFieldValues,
    computeFieldMetadata,
    updateFieldMapping,
    updateTransform,
    buildRichFieldMappings,
    clearForFile,
    clearAll,
  }
}
