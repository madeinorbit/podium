import { ISSUE_STAGES, type IssueStage, type IssueWire } from '@podium/protocol'
import { type IssuesOrdering, orderIssues } from './issues-display'

/**
 * Pure helpers for the hierarchical issue tracker view (#85): partition issues
 * into top-level roots + a children index, detect epics, and compute the
 * visible (expanded) row list the list view and keyboard nav share.
 */

/** An issue reads as an epic when it's typed as one OR it actually has children. */
export function isEpic(issue: IssueWire): boolean {
  return issue.type === 'epic' || issue.childCount > 0
}

/**
 * Generic parent/child partition. An item whose parent is absent from the input
 * (filtered out, deleted, or self-referential) is promoted to a root, so a
 * matching child never vanishes just because its parent was filtered away.
 */
export function partitionByParent<T>(
  items: T[],
  id: (t: T) => string,
  parentId: (t: T) => string | undefined,
): { roots: T[]; childrenByParent: Map<string, T[]> } {
  const ids = new Set(items.map(id))
  const roots: T[] = []
  const childrenByParent = new Map<string, T[]>()
  for (const item of items) {
    const p = parentId(item)
    if (p && p !== id(item) && ids.has(p)) {
      const arr = childrenByParent.get(p)
      if (arr) arr.push(item)
      else childrenByParent.set(p, [item])
    } else {
      roots.push(item)
    }
  }
  // Cycle fallback: a parentId cycle (A→B→A) leaves its members reachable from
  // NO root — they'd silently vanish from every view. Promote unreached items
  // to roots (mirrors the tracker's topo-order leftover fallback). Server-side
  // guards make this unreachable in practice; this is belt-and-braces.
  const reached = new Set<string>()
  const stack = roots.map(id)
  while (stack.length > 0) {
    const cur = stack.pop() as string
    if (reached.has(cur)) continue
    reached.add(cur)
    for (const child of childrenByParent.get(cur) ?? []) stack.push(id(child))
  }
  for (const item of items) {
    if (reached.has(id(item))) continue
    roots.push(item)
    // Everything under the promoted item is now reachable too.
    const sub = [id(item)]
    while (sub.length > 0) {
      const cur = sub.pop() as string
      if (reached.has(cur)) continue
      reached.add(cur)
      for (const child of childrenByParent.get(cur) ?? []) sub.push(id(child))
    }
  }
  return { roots, childrenByParent }
}

/** Partition issues into top-level roots + children keyed by parent id. */
export function partitionIssueTree(issues: IssueWire[]): {
  roots: IssueWire[]
  childrenByParent: Map<string, IssueWire[]>
} {
  return partitionByParent(
    issues,
    (i) => i.id,
    (i) => i.parentId,
  )
}

/** One visible list row: the issue, its nesting depth, and its expandable state. */
export interface IssueRow {
  issue: IssueWire
  depth: number
  /** Children this row would reveal (0 = no chevron). */
  childCount: number
  expanded: boolean
}

/**
 * Stage-grouped visible rows for the list view. Nested mode groups ROOTS by
 * their stage; an expanded root's children follow it, indented, regardless of
 * the child's own stage (its stage glyph disambiguates). `flatten` reproduces
 * the old flat view: every issue at depth 0 in its own stage group.
 */
export function issueRowsByStage(
  issues: IssueWire[],
  ordering: IssuesOrdering,
  opts: { flatten: boolean; expanded: ReadonlySet<string> },
): { stage: IssueStage; rows: IssueRow[] }[] {
  if (opts.flatten) {
    return ISSUE_STAGES.map((stage) => ({
      stage,
      rows: orderIssues(
        issues.filter((i) => i.stage === stage),
        ordering,
      ).map((issue) => ({ issue, depth: 0, childCount: 0, expanded: false })),
    }))
  }
  const { roots, childrenByParent } = partitionIssueTree(issues)
  const emit = (issue: IssueWire, depth: number, out: IssueRow[], path: Set<string>): void => {
    // Path guard: a parentId cycle (its members promoted to roots above) must
    // not recurse forever when every member is expanded.
    if (path.has(issue.id)) return
    const children = childrenByParent.get(issue.id) ?? []
    const expanded = children.length > 0 && opts.expanded.has(issue.id)
    out.push({ issue, depth, childCount: children.length, expanded })
    if (expanded) {
      const next = new Set(path).add(issue.id)
      for (const c of orderIssues(children, ordering)) emit(c, depth + 1, out, next)
    }
  }
  return ISSUE_STAGES.map((stage) => {
    const rows: IssueRow[] = []
    for (const root of orderIssues(
      roots.filter((i) => i.stage === stage),
      ordering,
    ))
      emit(root, 0, rows, new Set())
    return { stage, rows }
  })
}

/** Flatten row groups into ids in visual order — the keyboard-nav basis. */
export function flattenRowGroups(groups: { rows: IssueRow[] }[]): string[] {
  return groups.flatMap((g) => g.rows.map((r) => r.issue.id))
}

/**
 * Per-parent counts of DIRECT children by stage, in `ISSUE_STAGES` order, only
 * stages with a count > 0. Feeds the board's epic-card stage chips: with
 * roots-only lanes an in-progress child appears in no lane, so the parent card
 * itself must say where its children stand.
 */
export function childStageCounts(
  issues: IssueWire[],
): Map<string, { stage: IssueStage; count: number }[]> {
  const { childrenByParent } = partitionIssueTree(issues)
  const out = new Map<string, { stage: IssueStage; count: number }[]>()
  for (const [parent, children] of childrenByParent) {
    const counts = ISSUE_STAGES.map((stage) => ({
      stage,
      count: children.filter((c) => c.stage === stage).length,
    })).filter((c) => c.count > 0)
    if (counts.length > 0) out.set(parent, counts)
  }
  return out
}

/**
 * The prev/next order for the issue page: the visible rows when the open issue
 * is among them, else the full flat order — a deep-linked issue whose parent is
 * collapsed (or a child opened from the roots-only board) still gets a working
 * navigator instead of a dead one.
 */
export function issuePageOrderIds(
  visibleIds: string[],
  allIds: string[],
  openId: string,
): string[] {
  return visibleIds.includes(openId) ? visibleIds : allIds
}
