# Transform Detection Enhancements

This document outlines potential enhancements for smarter automatic transform detection when mapping CSV columns to Odoo fields.

## Current Implementation

Location: `src/views/ImportView.vue` → `computeFieldMetadataForFile()` (lines 371-398)

| Pattern | Transform | Condition |
|---------|-----------|-----------|
| `field/id` | `m2o_ref` | Field type is `many2one` |
| `field/id` | `m2m_ref` | Field type is `many2many` |
| `field/.id` | `db_id` | Field is relational |
| Everything else | `passthrough` | Default |

## Proposed Enhancements

### 1. Date/Datetime Detection

Analyze CSV sample values to detect date formats and auto-suggest appropriate parsing.

**Detection patterns:**
- ISO: `2024-01-15`, `2024-01-15T10:30:00`
- European: `15/01/2024`, `15.01.2024`
- US: `01/15/2024`, `Jan 15, 2024`
- Timestamps: `1705312200` (Unix)

**Transform config:**
```typescript
type DateTransform = {
  type: 'date'
  inputFormat: string  // e.g., 'DD/MM/YYYY', 'MM/DD/YYYY', 'ISO'
  outputFormat: 'date' | 'datetime'
}
```

**Implementation notes:**
- Use sample rows to detect the most common format
- Handle ambiguous formats (e.g., `01/02/2024` - is it Jan 2 or Feb 1?)
- Consider locale settings from Odoo user preferences

---

### 2. Boolean Detection

Detect common boolean representations in CSV data.

**Detection patterns:**
| True values | False values |
|-------------|--------------|
| `TRUE`, `true`, `True` | `FALSE`, `false`, `False` |
| `Yes`, `yes`, `Y`, `y` | `No`, `no`, `N`, `n` |
| `1` | `0` |
| `X`, `x` | (empty) |
| `Ja`, `Oui` (localized) | `Nein`, `Non` |

**Transform config:**
```typescript
type BooleanTransform = {
  type: 'boolean'
  trueValues: string[]
  falseValues: string[]
  emptyAs: boolean | null  // How to treat empty cells
}
```

**Implementation notes:**
- Only suggest when target Odoo field type is `boolean`
- Analyze all sample values to ensure consistency
- Warn if mixed/ambiguous values detected

---

### 3. Float/Integer Detection (Locale-Aware)

Handle number formats with different thousand/decimal separators.

**Detection patterns:**
| Format | Example | Locale |
|--------|---------|--------|
| US/UK | `1,234.56` | en_US |
| European | `1.234,56` | de_DE, fr_FR |
| Swiss | `1'234.56` | de_CH |
| No separator | `1234.56` | Universal |

**Transform config:**
```typescript
type NumberTransform = {
  type: 'number'
  thousandSeparator: ',' | '.' | "'" | ''
  decimalSeparator: '.' | ','
  outputType: 'integer' | 'float'
}
```

**Implementation notes:**
- Detect by analyzing decimal positions and separator patterns
- Consider Odoo field type (`integer` vs `float` vs `monetary`)
- Strip currency symbols if present (see monetary detection)

---

### 4. Selection Field Validation

When target Odoo field is type `selection`, validate and potentially map CSV values.

**Functionality:**
- Fetch allowed selection values from field metadata
- Compare CSV values against allowed options
- Suggest value mapping if close matches found (fuzzy matching)

**Transform config:**
```typescript
type SelectionTransform = {
  type: 'selection'
  valueMap: Record<string, string>  // CSV value → Odoo selection key
  strict: boolean  // Fail on unknown values?
}
```

**Example:**
```
CSV values: ["Active", "Inactive", "Pending"]
Odoo selection: [["active", "Active"], ["inactive", "Inactive"], ["pending", "Pending"]]
Auto-map: { "Active": "active", "Inactive": "inactive", "Pending": "pending" }
```

**Implementation notes:**
- Case-insensitive matching
- Levenshtein distance for fuzzy matching
- UI to manually map unmatched values

---

### 5. Many2many List Parsing

Detect when a single CSV cell contains multiple values that should become M2M records.

**Detection patterns:**
- Comma-separated: `value1, value2, value3`
- Pipe-separated: `value1|value2|value3`
- Semicolon-separated: `value1;value2;value3`
- Newline-separated: `value1\nvalue2`

**Transform config:**
```typescript
type M2mSplitTransform = {
  type: 'm2m_split'
  delimiter: ',' | '|' | ';' | '\n'
  trim: boolean
  refType: 'external_id' | 'db_id' | 'name_search'
  model: string
}
```

**Implementation notes:**
- Analyze sample values to detect consistent delimiter usage
- Combine with existing `m2m_ref` logic for reference resolution
- Handle quoted values containing delimiters

---

### 6. Monetary/Currency Detection

Detect currency values and strip formatting.

**Detection patterns:**
- `$1,234.56`, `€1.234,56`, `1234.56 USD`
- Currency symbols: `$`, `€`, `£`, `¥`, `CHF`, etc.
- Position: prefix or suffix

**Transform config:**
```typescript
type MonetaryTransform = {
  type: 'monetary'
  currencySymbol: string
  symbolPosition: 'prefix' | 'suffix'
  thousandSeparator: string
  decimalSeparator: string
}
```

**Implementation notes:**
- Only suggest when target field type is `monetary` or `float`
- Extract and optionally validate currency against Odoo currencies
- Consider multi-currency scenarios (currency in separate column)

---

## Implementation Approach

### New Function Signature

```typescript
function detectTransformFromSampleData(
  csvHeader: string,
  sampleValues: string[],
  odooField: string,
  fieldMeta: OdooField | undefined
): {
  transform: FieldTransform
  confidence: number  // 0-1, how confident is the detection
  warnings?: string[]
}
```

### Integration Point

Modify `computeFieldMetadataForFile()` to:
1. First check existing pattern-based detection (`/id`, `/.id`)
2. If `passthrough`, call `detectTransformFromSampleData()`
3. Only apply auto-detected transform if confidence > threshold (e.g., 0.8)
4. Store lower-confidence suggestions for UI display (user can accept/reject)

### UI Considerations

- Show confidence indicator next to auto-detected transforms
- Allow easy override via existing `TransformSelect`
- Display warnings for ambiguous detections
- "Analyze" button to re-run detection on full dataset (not just sample)

---

## Priority Order

1. **Boolean Detection** - High value, relatively simple
2. **Date/Datetime Detection** - Common pain point in imports
3. **Selection Field Validation** - Prevents errors, good UX
4. **Number Detection** - Important for international users
5. **M2M Split** - Useful but less common
6. **Monetary** - Niche use case
