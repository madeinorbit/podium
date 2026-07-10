/**
 * Pure keyboard-navigation reducer for the Issues board/list. Holds the focused
 * issue id and the multi-select set; a `IssuesNav` snapshot (the exact visual
 * order the view renders) is threaded in on every action so movement follows
 * what the user sees and vanished ids (moved / deleted / filtered) are dropped.
 */

export interface IssuesKeyState {
  focusId: string | null
  selected: string[]
}

/** The current visual layout: flat rows (list) or per-column stacks (board). */
export type IssuesNav = { kind: 'rows'; ids: string[] } | { kind: 'columns'; columns: string[][] }

export type IssuesKeyAction =
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'toggleSelect' }
  | { kind: 'clear' }

/** All ids in the nav, flattened in visual (top-to-bottom, left-to-right) order. */
function flatIds(nav: IssuesNav): string[] {
  return nav.kind === 'rows' ? nav.ids : nav.columns.flat()
}

/** Locate the focused id in the columns layout: which column, and its row index. */
function locate(columns: string[][], id: string): { col: number; row: number } | null {
  for (let col = 0; col < columns.length; col++) {
    const row = columns[col]?.indexOf(id) ?? -1
    if (row >= 0) return { col, row }
  }
  return null
}

/**
 * Advance focus across columns while keeping the row index (clamped to the
 * target column's length). Skips empty columns; no-op when there's no non-empty
 * column in `dir`. Only meaningful on the board (`columns`) layout.
 */
function horizontal(columns: string[][], focusId: string | null, dir: -1 | 1): string | null {
  if (focusId === null) return focusId
  const at = locate(columns, focusId)
  if (!at) return focusId
  for (let col = at.col + dir; col >= 0 && col < columns.length; col += dir) {
    const target = columns[col]
    if (target && target.length > 0) {
      const row = Math.min(at.row, target.length - 1)
      return target[row] ?? focusId
    }
  }
  return focusId
}

/** Step focus along the flattened order; clamp at both ends, `null` → first. */
function step(nav: IssuesNav, focusId: string | null, dir: -1 | 1): string | null {
  const ids = flatIds(nav)
  if (ids.length === 0) return null
  if (focusId === null) return ids[0] ?? null
  const i = ids.indexOf(focusId)
  if (i < 0) return ids[0] ?? null
  const next = Math.min(Math.max(i + dir, 0), ids.length - 1)
  return ids[next] ?? focusId
}

/**
 * Apply a keyboard action. First normalizes a focus id that's no longer present
 * in `nav` to `null`, then applies the action against the current visual order.
 */
export function issuesKeyReduce(
  s: IssuesKeyState,
  a: IssuesKeyAction,
  nav: IssuesNav,
): IssuesKeyState {
  const present = new Set(flatIds(nav))
  const focusId = s.focusId !== null && present.has(s.focusId) ? s.focusId : null
  const base: IssuesKeyState = focusId === s.focusId ? s : { ...s, focusId }

  switch (a.kind) {
    case 'next':
      return { ...base, focusId: step(nav, focusId, 1) }
    case 'prev':
      return { ...base, focusId: step(nav, focusId, -1) }
    case 'left':
      if (nav.kind !== 'columns') return base
      return { ...base, focusId: horizontal(nav.columns, focusId, -1) }
    case 'right':
      if (nav.kind !== 'columns') return base
      return { ...base, focusId: horizontal(nav.columns, focusId, 1) }
    case 'toggleSelect': {
      if (focusId === null) return base
      const selected = base.selected.includes(focusId)
        ? base.selected.filter((id) => id !== focusId)
        : [...base.selected, focusId]
      return { ...base, selected }
    }
    case 'clear':
      // Esc peels one layer: drop the selection first, then (once empty) focus.
      if (base.selected.length > 0) return { ...base, selected: [] }
      return { ...base, focusId: null }
  }
}
