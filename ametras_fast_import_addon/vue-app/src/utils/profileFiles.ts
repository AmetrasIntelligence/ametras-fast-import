import type { ProfileMapping, ProfileSequenceItem } from '@/types/importProfile'

/**
 * Unified, editable representation of a single file within a profile: its
 * target model (Modelzuordnungen tab) plus its position and dependencies
 * (Reihenfolge tab). Mirrors the addon's ``csv.import.profile.file`` child
 * model, where mappings (filename → model) and sequence (order + requires) are
 * merged into one row keyed by filename.
 */
export interface DraftFile {
  filename: string
  model: string
  requires: string[]
  /** Extra ProfileMapping props preserved verbatim (mode, searchKeys, …). */
  extra: Partial<ProfileMapping>
}

/**
 * Build the ordered draft-file list from a profile's mappings + sequence.
 * Order follows the sequence; any mapping-only files are appended after the
 * sequenced ones (stable).
 */
export function seedDraftFiles(
  mappings: ProfileMapping[],
  sequence: ProfileSequenceItem[]
): DraftFile[] {
  const orderByFile = new Map<string, number>()
  const requiresByFile = new Map<string, string[]>()
  for (const s of sequence) {
    orderByFile.set(s.filename, s.order)
    if (s.requires?.length) requiresByFile.set(s.filename, [...s.requires])
  }

  const files: DraftFile[] = mappings.map((m) => {
    const { filename, model, ...extra } = m
    return {
      filename,
      model: model || '',
      requires: requiresByFile.get(filename) ?? [],
      extra
    }
  })

  // Sequence-only files (present in sequence but missing from mappings).
  for (const s of sequence) {
    if (!files.some((f) => f.filename === s.filename)) {
      files.push({
        filename: s.filename,
        model: '',
        requires: requiresByFile.get(s.filename) ?? [],
        extra: {}
      })
    }
  }

  files.sort(
    (a, b) =>
      (orderByFile.get(a.filename) ?? Number.MAX_SAFE_INTEGER) -
      (orderByFile.get(b.filename) ?? Number.MAX_SAFE_INTEGER)
  )
  return files
}

/**
 * Serialize the draft-file list back into the profile wire format. The
 * sequence order is taken from the list position (1-based), so drag-reordering
 * in the Reihenfolge tab is preserved on save.
 */
export function buildFilesSaveData(files: DraftFile[]): {
  mappings: ProfileMapping[]
  sequence: ProfileSequenceItem[]
} {
  const mappings: ProfileMapping[] = files.map((f) => ({
    ...f.extra,
    filename: f.filename,
    model: f.model
  }))
  const sequence: ProfileSequenceItem[] = files.map((f, i) => {
    const item: ProfileSequenceItem = { order: i + 1, filename: f.filename }
    if (f.requires.length) item.requires = [...f.requires]
    return item
  })
  return { mappings, sequence }
}
