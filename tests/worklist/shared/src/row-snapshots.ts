import type { IssueModel } from '@podium/client-graph/models'
import { ROW_DISPLAYED_FIELDS, ROW_VIEW_FIELDS, type RowView } from '@podium/client-graph/shared/row-view'

/**
 * Whether a row must redraw between two views of it: a DISPLAYED field
 * differs (POD-4825). The values are primitives, `undefined`, or the plain
 * `originTick` object, compared by content.
 */
export function displayChanged(before: RowView, after: RowView): boolean {
  return ROW_DISPLAYED_FIELDS.some((field) => {
    const a: unknown = before[field]
    const b: unknown = after[field]
    if (a === b) return false
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return true
    return JSON.stringify(a) !== JSON.stringify(b)
  })
}

/**
 * POD-4756 — a row as ONE plain `RowView`: every field of `row`, read once,
 * copied (`loading` only when set, as a view spells it). A pool whose row is
 * a live object (the MobX arm's issue, which implements `RowView` and is read
 * field by field by its row component) projects through this where a plain
 * view is compared (the gate against its rebuild, tests); a plain view comes
 * back equal to itself.
 */
export function plainRowView(row: RowView): RowView {
  const view: Record<string, unknown> = {}
  for (const field of ROW_VIEW_FIELDS) {
    const value = row[field]
    if (field === 'loading' && value !== true) continue
    view[field] = value
  }
  return view as unknown as RowView
}

/**
 * The issue's row as ONE plain `RowView` (the projection through the
 * interface, `plainRowView`): what a gate or a test compares with the
 * rebuild. Undefined while the row is not in memory. Drawing never calls it.
 */
export function rowViewOf(issue: IssueModel | undefined): RowView | undefined {
  return issue === undefined || !issue.inMemory ? undefined : plainRowView(issue)
}
