export interface FieldMapping {
  filename: string
  csvHeader: string
  odooField: string
  required: boolean
  transform: FieldTransform
  notes?: string
}

// Phase 1: Very limited transform options
export type FieldTransform =
  | { type: 'passthrough' }
  | { type: 'm2o_ref'; model: string }

export function parseTransform(value: string): FieldTransform {
  if (!value || value.trim() === '') {
    return { type: 'passthrough' }
  }

  if (value.startsWith('m2o_ref:')) {
    const model = value.slice('m2o_ref:'.length)
    return { type: 'm2o_ref', model }
  }

  throw new Error(`Unknown transform: ${value}`)
}

export function serializeTransform(transform: FieldTransform): string {
  switch (transform.type) {
    case 'passthrough':
      return ''
    case 'm2o_ref':
      return `m2o_ref:${transform.model}`
  }
}
