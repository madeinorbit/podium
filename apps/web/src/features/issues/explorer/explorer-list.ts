import { issueIsActionable } from '@podium/client-core/viewmodels'
import {
  ISSUE_STATUS_LABELS,
  type IssueStage,
  issueStatusOf,
  issueStatusOutcome,
  type SessionMeta,
} from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import type { IssueViewModel } from '@/app/store'

/**
 * Level 0 of the issue explorer: which tasks it lists, in which order.
 *
 * The list is the WHOLE repo, not the mission on screen — the panel exists to
 * reach the task you are not working on. At this repo's scale that is several
 * hundred rows, so the stage tabs are not a filter convenience, they are what
 * stops the surface being one endless scroll.
 */

/**
 * `needs` is not a status — it is the attention bucket, and it comes first.
 * Everything else is a STATUS bucket, not a stage bucket (POD-1074): `done`,
 * `cancelled`, `duplicate` and `superseded` all park on the done LANE, so a
 * stage-keyed tab could only ever offer one lump for all four.
 */
export type ExplorerTab = 'needs' | Exclude<IssueStage, 'shipping'> | 'cancelled'

export const EXPLORER_TABS: readonly { id: ExplorerTab; label: string }[] = [
  { id: 'needs', label: 'Needs you' },
  { id: 'in_progress', label: ISSUE_STATUS_LABELS.in_progress },
  { id: 'review', label: ISSUE_STATUS_LABELS.review },
  { id: 'planning', label: ISSUE_STATUS_LABELS.planning },
  { id: 'backlog', label: ISSUE_STATUS_LABELS.backlog },
  { id: 'proposed', label: ISSUE_STATUS_LABELS.proposed },
  // TWO end buckets, not one, for the reason Linear keeps Completed and
  // Canceled apart: "we finished it" and "we are not doing it" are different
  // answers, and one tab holding both makes the Done count a lie. `Cancelled`
  // gathers the whole cancelled category — cancelled, duplicate, superseded.
  { id: 'done', label: ISSUE_STATUS_LABELS.done },
  { id: 'cancelled', label: ISSUE_STATUS_LABELS.cancelled },
]

/**
 * Which bucket a row belongs to. Null = no bucket: `shipping` is system-owned
 * custody with no tab of its own, and it must not fall into another one (the
 * stage-keyed version silently made its count `NaN`).
 */
export function explorerTabOf(issue: IssueViewModel): ExplorerTab | null {
  const status = issueStatusOf(issue)
  switch (status) {
    // The whole cancelled CATEGORY lands in one bucket — the row's own glyph
    // says which of the three it was.
    case 'cancelled':
    case 'duplicate':
    case 'superseded':
      return 'cancelled'
    case 'shipping':
      return null
    default:
      return status
  }
}

/** Sessions per issue, by the same membership rule the rest of the shell uses
 *  (attached by `issueId`, or declared in `memberSessionIds`). Built once for a
 *  whole list pass — the per-issue helper is O(sessions) and this is O(n·m). */
function sessionsByIssue(
  issues: readonly IssueViewModel[],
  sessions: readonly SessionMeta[],
): Map<string, SessionMeta[]> {
  const memberOf = new Map<string, string>()
  for (const issue of issues) {
    for (const sessionId of issue.memberSessionIds ?? []) memberOf.set(sessionId, issue.id)
  }
  const byIssue = new Map<string, SessionMeta[]>()
  for (const session of sessions) {
    if (session.archived) continue
    const owner = session.issueId ?? memberOf.get(session.sessionId)
    if (!owner) continue
    const list = byIssue.get(owner)
    if (list) list.push(session)
    else byIssue.set(owner, [session])
  }
  return byIssue
}

/** Archive is a soft hide everywhere else in the shell; it hides here too. */
function listable(issue: IssueViewModel): boolean {
  return !issue.archived && !issue.deletedAt
}

/** Newest activity first — the order that makes "the task I just touched" the
 *  first thing in every tab. */
function byRecency(a: IssueViewModel, b: IssueViewModel): number {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
}

/** Ref and title only. Searching bodies would return rows whose match the
 *  operator cannot see, which reads as a broken filter rather than a deep one. */
export function matchesQuery(issue: IssueViewModel, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${issueDisplayRef(issue)} ${issue.title}`.toLowerCase().includes(q)
}

/**
 * The rows to render.
 *
 * A live query OVERRIDES the tab and searches every stage: someone typing a ref
 * wants that task, not that task if it happens to be in the bucket they last
 * clicked. The caller says so in the list header rather than leaving the
 * inactive tab strip to imply a filter that is not running.
 */
export function explorerRows(
  issues: readonly IssueViewModel[],
  sessions: readonly SessionMeta[],
  opts: { tab: ExplorerTab; query: string },
): IssueViewModel[] {
  const open = issues.filter(listable)
  const query = opts.query.trim()
  if (query) {
    const normalized = query.toLowerCase()
    // Archive is a browsing boundary, not an identity boundary. A person who
    // supplies the whole ref already knows which task they want, so let that
    // one archived row cross it. Partial refs and title prose still run over
    // `open` only; typing "minimap" must not turn search into an archive dump.
    const archivedExactRefs = issues.filter(
      (issue) =>
        issue.archived &&
        !issue.deletedAt &&
        issueDisplayRef(issue).toLowerCase() === normalized,
    )
    return [...open.filter((issue) => matchesQuery(issue, query)), ...archivedExactRefs].sort(
      byRecency,
    )
  }
  if (opts.tab === 'needs') {
    const byIssue = sessionsByIssue(issues, sessions)
    return open
      .filter((issue) => issueIsActionable(issue, byIssue.get(issue.id) ?? []))
      .sort(byRecency)
  }
  return open.filter((issue) => explorerTabOf(issue) === opts.tab).sort(byRecency)
}

/** The count beside each tab. `needs` runs the SAME predicate as the rail's
 *  portfolio badge, so the two numbers can never disagree. */
export function explorerCounts(
  issues: readonly IssueViewModel[],
  sessions: readonly SessionMeta[],
): Record<ExplorerTab, number> {
  const byIssue = sessionsByIssue(issues, sessions)
  const counts: Record<ExplorerTab, number> = {
    needs: 0,
    proposed: 0,
    backlog: 0,
    planning: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    cancelled: 0,
  }
  for (const issue of issues) {
    if (!listable(issue)) continue
    const tab = explorerTabOf(issue)
    if (tab) counts[tab] += 1
    if (issueIsActionable(issue, byIssue.get(issue.id) ?? [])) counts.needs += 1
  }
  return counts
}

/** Which tab to land on when the explorer has never been opened: the first one
 *  with anything in it, so the operator never opens onto an empty list. */
export function defaultTab(counts: Record<ExplorerTab, number>): ExplorerTab {
  return EXPLORER_TABS.find((tab) => counts[tab.id] > 0)?.id ?? 'in_progress'
}
