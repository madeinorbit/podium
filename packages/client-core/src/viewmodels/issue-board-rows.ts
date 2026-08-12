import { ISSUE_STAGES, type IssueStage } from '@podium/model'

/**
 * ONE DERIVATION OF "WHAT ROWS DOES A TASK BOARD SHOW, IN WHAT ORDER" [POD-724].
 *
 * These four helpers — partition into roots + children, order a group, group by
 * stage, and emit the visible nested rows — lived in `apps/web/src/features/issues`
 * and were typed over the web's `IssueViewModel`. The phone's Tasks tab therefore
 * could not use them, so it grew its own answer: every scoped issue flat at top
 * level, ordered by `priority DESC seq`. The two surfaces then disagreed about
 * what a board IS. An agent's internal decomposition sub-issue — a child that
 * exists so an epic can be worked, and which the desktop only ever shows nested
 * under its parent — appeared on the phone as a peer of the work it belongs to.
 * That is the "many strange tasks" the operator saw, and it was a second
 * derivation, not a filter bug.
 *
 * So the derivation moved here, verbatim, and both platforms call it. The
 * `published.ts` doctrine says one derivation, not one per platform; this is that
 * rule applied to the board.
 *
 * STRUCTURAL, NOT NOMINAL. The functions are generic over {@link BoardRowIssue} —
 * the seven fields they actually read — so `IssueWire` (phone) and
 * `IssueViewModel` (desktop) both satisfy it without this package having to know
 * either name. The generic parameter is preserved through the return types, so a
 * caller gets its own row type back and not a widened one.
 */

/** How a stage group orders its members. */
export type IssuesOrdering = 'priority' | 'updated' | 'created'

/**
 * The minimum an issue must carry to be placed on a board: an identity, a
 * parent edge, the lane it sits in, and the three sort keys. Deliberately not
 * `IssueWire` — a board does not read a description, a panel or a git state, and
 * requiring them would make this module un-shareable the moment either platform's
 * row shape moved.
 */
export interface BoardRowIssue {
  id: string
  parentId?: string | undefined
  stage: IssueStage
  priority: number
  seq: number
  createdAt: string
  updatedAt: string
}

/** Stable ordering for board columns and list groups. Pure — returns a copy. */
export function orderIssues<T extends BoardRowIssue>(issues: T[], ordering: IssuesOrdering): T[] {
  const c = [...issues]
  if (ordering === 'priority') c.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
  else if (ordering === 'updated') c.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  else c.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return c
}

/** Group active issues into all six lifecycle stages (board parity: every stage
 *  is present even when empty), each group internally ordered by `ordering`. */
export function groupIssuesByStage<T extends BoardRowIssue>(
  issues: T[],
  ordering: IssuesOrdering,
): { stage: IssueStage; issues: T[] }[] {
  return ISSUE_STAGES.map((stage) => ({
    stage,
    issues: orderIssues(
      issues.filter((i) => i.stage === stage),
      ordering,
    ),
  }))
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
export function partitionIssueTree<T extends BoardRowIssue>(
  issues: T[],
): { roots: T[]; childrenByParent: Map<string, T[]> } {
  return partitionByParent(
    issues,
    (i) => i.id,
    (i) => i.parentId,
  )
}

/** One visible list row: the issue, its nesting depth, and its expandable state. */
export interface IssueRow<T extends BoardRowIssue = BoardRowIssue> {
  issue: T
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
export function issueRowsByStage<T extends BoardRowIssue>(
  issues: T[],
  ordering: IssuesOrdering,
  opts: { flatten: boolean; expanded: ReadonlySet<string> },
): { stage: IssueStage; rows: IssueRow<T>[] }[] {
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
  const emit = (issue: T, depth: number, out: IssueRow<T>[], path: Set<string>): void => {
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
    const rows: IssueRow<T>[] = []
    for (const root of orderIssues(
      roots.filter((i) => i.stage === stage),
      ordering,
    ))
      emit(root, 0, rows, new Set())
    return { stage, rows }
  })
}

/**
 * Flatten row groups into ids in visual order — the keyboard-nav basis on the
 * desktop and the prev/next basis on the phone. Generic in the ID so a branded
 * `IssueId` survives the round trip instead of widening to `string`.
 */
export function flattenRowGroups<I extends string>(
  groups: readonly { rows: readonly { issue: { id: I } }[] }[],
): I[] {
  return groups.flatMap((g) => g.rows.map((r) => r.issue.id))
}

/** Flatten grouped issues into their ids in visual (top-to-bottom) order —
 *  the basis for prev/next navigation and list keyboard movement. */
export function flattenStageGroups<I extends string>(
  groups: readonly { issues: readonly { id: I }[] }[],
): I[] {
  return groups.flatMap((g) => g.issues.map((i) => i.id))
}
