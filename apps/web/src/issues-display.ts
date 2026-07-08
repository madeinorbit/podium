import type { IssueWire } from '@podium/protocol'

export type IssuesLayout = 'board' | 'list'
export type IssuesOrdering = 'priority' | 'updated' | 'created'

export interface IssuesDisplay {
  layout: IssuesLayout
  ordering: IssuesOrdering
  /** true = the old flat view (sub-issues at top level); false = nested (#85). */
  flatten: boolean
  /** Show internal (audience: 'agent') issues at top level (issue-as-workspace).
   *  Default OFF — internal tasks only surface as children under their (visible,
   *  human-audience) parent. */
  showAgentTasks: boolean
  badges: { labels: boolean; type: boolean; estimate: boolean; due: boolean; sessions: boolean }
}

export const DISPLAY_KEY = 'podium.issues.display'

export const DEFAULT_DISPLAY: IssuesDisplay = {
  layout: 'board',
  ordering: 'updated',
  flatten: false,
  showAgentTasks: false,
  badges: { labels: true, type: true, estimate: true, due: true, sessions: true },
}

const LAYOUTS = new Set<string>(['board', 'list'])
const ORDERINGS = new Set<string>(['priority', 'updated', 'created'])

/** Parse a persisted display-options blob, falling back field-by-field so a
 *  stale or hand-edited value never breaks the view. */
export function readIssuesDisplay(raw: string | null): IssuesDisplay {
  if (!raw) return DEFAULT_DISPLAY
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return DEFAULT_DISPLAY
  }
  if (typeof v !== 'object' || v == null) return DEFAULT_DISPLAY
  const o = v as Record<string, unknown>
  const badges = (typeof o.badges === 'object' && o.badges != null ? o.badges : {}) as Record<
    string,
    unknown
  >
  const badge = (k: keyof IssuesDisplay['badges']): boolean =>
    typeof badges[k] === 'boolean' ? (badges[k] as boolean) : DEFAULT_DISPLAY.badges[k]
  return {
    layout: LAYOUTS.has(String(o.layout)) ? (o.layout as IssuesLayout) : DEFAULT_DISPLAY.layout,
    ordering: ORDERINGS.has(String(o.ordering))
      ? (o.ordering as IssuesOrdering)
      : DEFAULT_DISPLAY.ordering,
    flatten: typeof o.flatten === 'boolean' ? o.flatten : DEFAULT_DISPLAY.flatten,
    showAgentTasks:
      typeof o.showAgentTasks === 'boolean' ? o.showAgentTasks : DEFAULT_DISPLAY.showAgentTasks,
    badges: {
      labels: badge('labels'),
      type: badge('type'),
      estimate: badge('estimate'),
      due: badge('due'),
      sessions: badge('sessions'),
    },
  }
}

export function writeIssuesDisplay(d: IssuesDisplay): string {
  return JSON.stringify(d)
}

/**
 * Board/list scope filter (issue-as-workspace): drafts never show on the board
 * (they live in the sidebar), and internal (audience: 'agent') issues are hidden
 * unless `showAgentTasks` — EXCEPT children whose parent survives the filter,
 * which always ride under it (epic drill-down shows all children).
 *
 * Keys on `audience` (who the issue is FOR, #198), NOT `origin` (who created it):
 * an agent acting for the human can cut a human-audience issue that belongs on the
 * board, and the human's own quick note to an agent can be internal.
 */
export function filterBoardScope(issues: IssueWire[], showAgentTasks: boolean): IssueWire[] {
  const noDrafts = issues.filter((i) => !i.draft)
  if (showAgentTasks) return noDrafts
  const byId = new Map(noDrafts.map((i) => [i.id, i]))
  const topLevelVisible = (i: IssueWire): boolean => i.audience !== 'agent'
  return noDrafts.filter((i) => {
    if (topLevelVisible(i)) return true
    // Internal (audience: agent): keep only when some ancestor chain reaches a
    // visible issue — it then shows as a child under that parent, not at top level.
    let cur = i
    const seen = new Set<string>([i.id])
    while (cur.parentId) {
      const parent = byId.get(cur.parentId)
      if (!parent || seen.has(parent.id)) return false
      if (topLevelVisible(parent)) return true
      seen.add(parent.id)
      cur = parent
    }
    return false
  })
}

/** Progress rollup for a human-audience epic (#198): counts across its full
 *  descendant subtree so the human tracks "how far along" without seeing the
 *  internal churn. `done` counts descendants at stage 'done'; `liveAgents` counts
 *  descendants with at least one live session. Returns null when the issue has no
 *  descendants (nothing to roll up — render nothing). Pure. */
export interface EpicProgress {
  total: number
  done: number
  liveAgents: number
}

/** parent id → non-draft children. Built ONCE per render and shared across all
 *  roots so the rollup is O(n), not O(roots·n) (a hot-path re-scan otherwise). */
type ChildrenIndex = Map<string, IssueWire[]>
function buildChildrenIndex(issues: IssueWire[]): ChildrenIndex {
  const childrenOf: ChildrenIndex = new Map()
  for (const i of issues) {
    if (i.draft || !i.parentId) continue
    const arr = childrenOf.get(i.parentId)
    if (arr) arr.push(i)
    else childrenOf.set(i.parentId, [i])
  }
  return childrenOf
}

function progressFrom(childrenOf: ChildrenIndex, epicId: string): EpicProgress | null {
  let total = 0
  let done = 0
  let liveAgents = 0
  const seen = new Set<string>([epicId])
  const stack = [...(childrenOf.get(epicId) ?? [])]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (seen.has(node.id)) continue
    seen.add(node.id)
    total += 1
    if (node.stage === 'done') done += 1
    if (node.sessions.some((s) => s.status === 'live')) liveAgents += 1
    for (const child of childrenOf.get(node.id) ?? []) stack.push(child)
  }
  return total === 0 ? null : { total, done, liveAgents }
}

export function computeEpicProgress(issues: IssueWire[], epicId: string): EpicProgress | null {
  return progressFrom(buildChildrenIndex(issues), epicId)
}

/** Batch rollup for many roots over one shared child index (see buildChildrenIndex) —
 *  the board's per-render entry point, keeping the pass O(n) total. */
export function computeEpicProgressMap(
  issues: IssueWire[],
  rootIds: string[],
): Map<string, EpicProgress | null> {
  const childrenOf = buildChildrenIndex(issues)
  return new Map(rootIds.map((id) => [id, progressFrom(childrenOf, id)]))
}

/** Stable ordering for board columns and list groups. Pure — returns a copy. */
export function orderIssues(issues: IssueWire[], ordering: IssuesOrdering): IssueWire[] {
  const c = [...issues]
  if (ordering === 'priority') c.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
  else if (ordering === 'updated') c.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  else c.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return c
}
