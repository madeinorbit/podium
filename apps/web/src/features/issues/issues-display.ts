import {
  confirmedWorkingAgentCount as coreConfirmedWorkingAgentCount,
  confirmedWorkingAgentCountsByIssue as coreConfirmedWorkingAgentCountsByIssue,
  orderIssues as coreOrderIssues,
  readSharedIssuesDisplay,
  type TaskProgress,
  taskProgressMap,
  type IssuesOrdering,
  writeSharedIssuesDisplay,
} from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model/browser'
import type { IssueViewModel } from '@/app/store'

export type IssuesLayout = 'board' | 'list'
/** Ordering is the SHARED vocabulary now (POD-724) — the phone's Tasks tab reads
 *  the same union and calls the same comparator. */
export type { IssuesOrdering }

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

export { ISSUES_DISPLAY_KEY as DISPLAY_KEY } from '@podium/client-core/ui-state'

export const DEFAULT_DISPLAY: IssuesDisplay = {
  layout: 'board',
  // Priority-first by default: the board's job is triage, so the most urgent
  // work sits at the top of each stage column. `updated` also churned the
  // columns every time an agent touched an issue; priority + seq holds still.
  ordering: 'priority',
  flatten: false,
  showAgentTasks: false,
  badges: { labels: true, type: true, estimate: true, due: true, sessions: true },
}

const LAYOUTS = new Set<string>(['board', 'list'])
/** Parse a persisted display-options blob, falling back field-by-field so a
 *  stale or hand-edited value never breaks the view. */
export function readIssuesDisplay(raw: string | null): IssuesDisplay {
  const shared = readSharedIssuesDisplay(raw)
  const o = shared.source
  const badges = (typeof o.badges === 'object' && o.badges != null ? o.badges : {}) as Record<
    string,
    unknown
  >
  const badge = (k: keyof IssuesDisplay['badges']): boolean =>
    typeof badges[k] === 'boolean' ? (badges[k] as boolean) : DEFAULT_DISPLAY.badges[k]
  return {
    layout: LAYOUTS.has(String(o.layout)) ? (o.layout as IssuesLayout) : DEFAULT_DISPLAY.layout,
    ordering: shared.ordering,
    flatten: typeof o.flatten === 'boolean' ? o.flatten : DEFAULT_DISPLAY.flatten,
    showAgentTasks: shared.showAgentTasks,
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
  return writeSharedIssuesDisplay({
    ordering: d.ordering,
    showAgentTasks: d.showAgentTasks,
    source: { ...d },
  })
}

// The board scope filter is platform-neutral and lives in client-core so the
// phone board derives from the same predicate (POD-338).
export { boardIssues, filterBoardScope } from '@podium/client-core/viewmodels'

/** Progress rollup for a human-audience epic (#198): counts across its full
 *  descendant subtree so the human tracks "how far along" without seeing the
 *  internal churn. `done` counts descendants at stage 'done'; `liveAgents` counts
 *  agents whose process and harness activity Podium can confirm right now.
 *  Returns null when the issue has no descendants (nothing to roll up — render
 *  nothing). Pure. */
export type EpicProgress = TaskProgress

/** The board's spelling of the shared confirmed-computing predicate. */
export function confirmedWorkingAgentCount(sessions: readonly SessionMeta[], now: number): number {
  return coreConfirmedWorkingAgentCount(sessions, now)
}

/** Confirmed issue workers, keyed through canonical issue membership. */
export function confirmedWorkingAgentCountsByIssue(
  issues: readonly IssueViewModel[],
  sessions: readonly SessionMeta[],
  now: number,
): Map<string, number> {
  return coreConfirmedWorkingAgentCountsByIssue(issues, sessions, now)
}

export function computeEpicProgress(
  issues: IssueViewModel[],
  epicId: string,
  sessions: readonly SessionMeta[] = [],
  now = Date.now(),
): EpicProgress | null {
  return (
    taskProgressMap(
      issues,
      [epicId],
      confirmedWorkingAgentCountsByIssue(issues, sessions, now),
    ).get(epicId) ?? null
  )
}

/** Batch rollup for many roots over one shared child index (see buildChildrenIndex) —
 *  the board's per-render entry point, keeping the pass O(n) total. */
export function computeEpicProgressMap(
  issues: IssueViewModel[],
  rootIds: string[],
  sessions: readonly SessionMeta[] = [],
  now = Date.now(),
): Map<string, EpicProgress | null> {
  const workingByIssue = confirmedWorkingAgentCountsByIssue(issues, sessions, now)
  return taskProgressMap(issues, rootIds, workingByIssue)
}

/** Stable ordering for board columns and list groups. Pure — returns a copy.
 *  The comparator itself lives in client-core (POD-724). */
export function orderIssues(issues: IssueViewModel[], ordering: IssuesOrdering): IssueViewModel[] {
  return coreOrderIssues(issues, ordering)
}
