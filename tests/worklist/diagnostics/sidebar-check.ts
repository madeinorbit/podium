/** Diagnostic-only differential over two snapshots of one screen's sections.
 * Reports contain locations and IDs, never titles, questions or row values.
 */
import { compareStructural } from 'mobx'

export interface CheckRow {
  readonly id: string
  /** Only payload comparisons wait for this row's batched loads. */
  readonly pending?: boolean
  /** An incomplete worktree roster can change membership and sort order.
   * Defer this ID in both sequences; all other IDs retain their relative order. */
  readonly placementPending?: boolean
  readonly fields: Readonly<Record<string, unknown>>
}
export interface CheckSection {
  readonly key: string
  readonly fields: Readonly<Record<string, unknown>>
  /** Header facts whose inputs are explicitly awaiting a batched load. */
  readonly pendingFields?: readonly string[]
  readonly rows: readonly CheckRow[]
}
export interface SidebarSnapshot {
  readonly sections: readonly CheckSection[]
  readonly pending: number
}
export interface SidebarDifference {
  readonly section: string
  readonly sectionIndex: number
  readonly rowIndex: number | null
  readonly expectedId: string | null
  readonly actualId: string | null
  readonly field: string
}
export interface SidebarCheckResult {
  readonly differences: number
  readonly first: SidebarDifference | null
  readonly pending: number
  readonly sections: number
  readonly rows: number
}

/** Finds the first leaf, including absent keys and extra array elements. */
function differingField(expected: unknown, actual: unknown, path = ''): string | null {
  if (compareStructural(expected, actual)) return null
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object') {
    const e = expected as Record<string, unknown>, a = actual as Record<string, unknown>
    for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) {
      const next = Array.isArray(expected) ? `${path}[${key}]` : path ? `${path}.${key}` : key
      if (!Object.hasOwn(e, key) || !Object.hasOwn(a, key)) return next
      const field = differingField(e[key], a[key], next)
      if (field !== null) return field
    }
  }
  return path || 'value'
}

/** Compare known membership in display order, and payloads once settled.
 * A global pending count never suppresses a mismatch. Provisional roster IDs
 * rejoin the complete structural comparison as soon as their loads settle. */
export function compareSidebarSnapshots(expected: SidebarSnapshot, actual: SidebarSnapshot, onDifference?: (difference: SidebarDifference) => void): SidebarCheckResult {
  let differences = 0, first: SidebarDifference | null = null
  const flag = (difference: SidebarDifference): void => { differences += 1; first ??= difference; onDifference?.(difference) }
  for (let sectionIndex = 0; sectionIndex < Math.max(expected.sections.length, actual.sections.length); sectionIndex += 1) {
    const e = expected.sections[sectionIndex], a = actual.sections[sectionIndex]
    const location = { section: e?.key ?? a?.key ?? '', sectionIndex, rowIndex: null, expectedId: e?.key ?? null, actualId: a?.key ?? null }
    if (!e || !a || e.key !== a.key) { flag({ ...location, field: 'section' }); continue }
    const pendingFields = new Set([...(e.pendingFields ?? []), ...(a.pendingFields ?? [])])
    const settledFields = (fields: CheckSection['fields']) => Object.fromEntries(Object.entries(fields).filter(([key]) => !pendingFields.has(key)))
    const field = differingField(settledFields(e.fields), settledFields(a.fields))
    if (field !== null) flag({ ...location, field })
    const provisional = new Set([...e.rows, ...a.rows].filter(row => row.placementPending).map(row => row.id))
    const expectedRows = e.rows.map((row, index) => ({ row, index })).filter(({ row }) => !provisional.has(row.id))
    const actualRows = a.rows.map((row, index) => ({ row, index })).filter(({ row }) => !provisional.has(row.id))
    for (let index = 0; index < Math.max(expectedRows.length, actualRows.length); index += 1) {
      const expectedRow = expectedRows[index], actualRow = actualRows[index]
      const er = expectedRow?.row, ar = actualRow?.row
      const rowIndex = expectedRow?.index ?? actualRow!.index
      const rowLocation = { ...location, rowIndex, expectedId: er?.id ?? null, actualId: ar?.id ?? null }
      if (!er || !ar || er.id !== ar.id) { flag({ ...rowLocation, field: 'id' }); continue }
      if (er.pending || ar.pending) continue
      const rowField = differingField(er.fields, ar.fields)
      if (rowField !== null) flag({ ...rowLocation, field: rowField })
    }
  }
  return { differences, first, pending: expected.pending + actual.pending, sections: expected.sections.length,
    rows: expected.sections.reduce((count, section) => count + section.rows.length, 0) }
}
