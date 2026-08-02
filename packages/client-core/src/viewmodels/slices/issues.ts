/**
 * ISSUES SLICE (POD-330) — the issue as an entity: its nav model, its sub-issue
 * tree, and what the human is being asked to DECIDE about it.
 *
 * Boundary that keeps this a slice and not a second worklist: everything here
 * takes ISSUES (and, at most, the sessions that belong to one) and returns a
 * fact about them. Nothing here knows what a unified work ROW is, how rows are
 * banded, ordered, folded or grouped, or that a sidebar exists. Those are
 * worklist questions, and the worklist consumes this slice's published output —
 * a one-way edge (`worklist -> issues`).
 *
 * That edge is the one the ownership map's original census MISSED, because a
 * census of external consumers cannot see edges that live inside the file being
 * cut: `issuePendingDecision` and `issueFinishedAt` have no importer outside
 * `derive.ts`, yet `rowStatusLine` and `rowInClosedFold` both reach them. They
 * are issue facts that the worklist reads, so they are published here rather
 * than duplicated there.
 *
 * CROSS-BOUNDARY EDGES (docs/multi-user-readiness.md §3.1.2). A parent, a
 * blocker or a started-by pointer may address an issue the principal cannot
 * see. Whether that renders as HIDDEN or as an OPAQUE reference is a product
 * decision the doc deliberately leaves open, so this slice publishes BOTH
 * shapes and takes the policy as an argument. No slice default decides it.
 *
 * Depends on F1 (session-status), F2 (session-ownership) and F3
 * (session-urgency). Imports no other slice.
 * Platform-neutral: no DOM, no storage.
 */
import { isHeadlessSession, type IssueWire, type SessionMeta } from '@podium/model'
import { panelLabel } from '../session-status'
import {
  resolveReferent,
  sessionsForIssueNav,
  sessionsForIssueWorktree,
  type ReferentExit,
  type ReferentResolution,
} from '../session-ownership'
import { sortSessionsForSidebar } from '../session-urgency'

// ---------------------------------------------------------------------------
// The issue nav model, and the sub-issue tree.
// ---------------------------------------------------------------------------

export type IssueNavigationModel = Omit<IssueWire, 'commentCount'> & {
  memberSessionIds?: string[]
  unread?: boolean
  sessionSummary?: { total: number; byPhase: Record<string, number> }
}

/** A parent/epic's direct children, seq-ordered, INCLUDING archived ones (issue
 *  #133). The subissue list keeps archived children visible (the UI marks them
 *  archived) rather than dropping them, so archiving a child doesn't silently
 *  vanish it from its parent. Scoped to the subissue list — the main board's
 *  default hide-archived behavior is unchanged. */
export function subIssuesOf<T extends Pick<IssueWire, 'parentId' | 'deletedAt' | 'seq'>>(
  issues: readonly T[],
  parentId: string,
): T[] {
  return issues.filter((i) => i.parentId === parentId && !i.deletedAt).sort((a, b) => a.seq - b.seq)
}

/** Roll-up stats for a subtree hidden behind the sidebar's depth cap (POD-100
 *  L4): every non-archived descendant of `rootId` via formal parentId edges —
 *  including done children that already decayed out of their own rows, since
 *  history is the k/m, not rows (L5). Cycle-safe.
 *
 *  PARTIAL WORLD: this counts what is VISIBLE. A descendant the principal may
 *  not see is not counted, and is not guessed at either — the count is honest
 *  about the world this replica holds. Leaking "there are 3 more you cannot
 *  see" is an existence fact and therefore a §3.1.2 policy question, not a
 *  default this function may take. */
export function branchRollup(
  issues: readonly IssueWire[],
  rootId: string,
): { total: number; done: number } {
  const childrenOf = new Map<string, IssueWire[]>()
  for (const issue of issues) {
    if (issue.archived || issue.deletedAt || !issue.parentId) continue
    const list = childrenOf.get(issue.parentId) ?? []
    list.push(issue)
    childrenOf.set(issue.parentId, list)
  }
  let total = 0
  let done = 0
  const seen = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const child of childrenOf.get(id) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      total += 1
      if (child.stage === 'done' || child.closedReason != null) done += 1
      stack.push(child.id)
    }
  }
  return { total, done }
}

// ---------------------------------------------------------------------------
// Cross-boundary edges. Renderable BOTH ways; the policy is the caller's.
// ---------------------------------------------------------------------------

/** How this surface renders an edge whose target the principal cannot see.
 *  §3.1.2 leaves the choice open; it is passed in, never defaulted by a slice. */
export type CrossBoundaryPolicy = 'hidden' | 'opaque'

/** An edge to another issue, resolved against a partial world.
 *
 *  `render: 'hidden'` means the consumer must not draw the edge at all;
 *  `'opaque'` means draw it WITHOUT identity ("blocked by an issue you do not
 *  have access to"). An opaque edge carries no title, no ref and no stage —
 *  publishing an id the principal may not resolve is the leak the policy is
 *  about, so the reference is deliberately anonymous.
 *
 *  `'pending'` renders as neither: it has not arrived YET and is the one state a
 *  spinner is correct for. */
export interface IssueEdge {
  readonly resolution: ReferentResolution<IssueWire>
  readonly render: 'issue' | 'opaque' | 'hidden' | 'pending'
}

export function resolveIssueEdge(
  targetId: string | undefined | null,
  lookup: (id: string) => IssueWire | undefined,
  policy: CrossBoundaryPolicy,
  exitOf: (id: string) => ReferentExit | undefined = () => undefined,
): IssueEdge {
  const resolution = resolveReferent(targetId, lookup, exitOf)
  switch (resolution.state) {
    case 'present':
      return { resolution, render: 'issue' }
    case 'not-visible':
      // The entity EXISTS. Rendering it as removed is the defect; which of the
      // two honest shapes to use is the caller's policy.
      return { resolution, render: policy }
    case 'pending':
      return { resolution, render: 'pending' }
    default:
      // Genuinely deleted (or never referenced): there is no edge to draw.
      return { resolution, render: 'hidden' }
  }
}

// ---------------------------------------------------------------------------
// The sidebar Issues tab.
// ---------------------------------------------------------------------------

export interface IssueNavView {
  issue: IssueNavigationModel
  repoName: string
  sessions: SessionMeta[]
  activityAt: number
}

/** Flat, activity-sorted issue list for the sidebar Issues tab. Each issue carries
 *  its live sessions (from the session stream, not the wire snapshot) so badges and
 *  ordering stay fresh. Archived issues are dropped. Most-recently-active first;
 *  issues with no sessions fall back to their updatedAt. */
export function issueNavList(
  issues: IssueNavigationModel[],
  sessions: SessionMeta[],
  now: number = Date.now(),
): IssueNavView[] {
  const views = issues
    .filter((i) => !i.archived && !i.deletedAt)
    .map((issue): IssueNavView => {
      const memberIds = issue.memberSessionIds
      const mine = sortSessionsForSidebar(
        memberIds === undefined
          ? sessionsForIssueWorktree(sessions, issue.worktreePath)
          : sessions.filter(
              (session) => memberIds.includes(session.sessionId) && !isHeadlessSession(session),
            ),
        now,
      )
      const lastSession = mine.reduce((max, s) => Math.max(max, Date.parse(s.lastActiveAt) || 0), 0)
      const activityAt = lastSession || Date.parse(issue.updatedAt) || 0
      const repoName = issue.repoPath.split('/').filter(Boolean).pop() ?? issue.repoPath
      return { issue, repoName, sessions: mine, activityAt }
    })
  return views.sort((a, b) => b.activityAt - a.activityAt)
}

/** Narrow the issue list by the sidebar filter text — issue title, repo name, or stage. */
export function filterIssueNav(list: IssueNavView[], query: string): IssueNavView[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (v) =>
      v.issue.title.toLowerCase().includes(q) ||
      v.repoName.toLowerCase().includes(q) ||
      v.issue.stage.toLowerCase().includes(q),
  )
}

/** Row label for a DRAFT issue (placeholder-titled vessel): a name someone chose
 *  for the attached session — a user rename or the agent's own `podium session
 *  title` — otherwise "New <kind> session" until one arrives.
 *
 *  Deliberately NOT the session's live title: that is the harness's OSC terminal
 *  string, not a name. Claude Code seeds it from its GLOBAL history, so a session
 *  that has not summarized itself yet surfaces an unrelated older conversation —
 *  and the vessel row, which is the only place a draft issue is named, would
 *  advertise work the user never started here. Wait for the real name instead. */
export function draftIssueLabel(
  issue: IssueNavigationModel,
  sessions: SessionMeta[],
  allWorktreePaths: string[],
): string {
  const first = sessionsForIssueNav(issue, sessions, allWorktreePaths)[0]
  if (!first) return 'New agent'
  return first.name?.trim() || `New ${panelLabel(first.agentKind)} session`
}

/** A DRAFT vessel whose only content is its agents: no worktree of its own, no
 *  title the human chose. It is a session container, not work — its sidebar row
 *  IS the agent (clicking opens the session, nothing folds out beneath it), so
 *  it can never parent real work either. Both the nesting decision and the row
 *  rendering read this one predicate so they cannot drift apart (POD-282). */
export function isDraftAgentVessel(issue: IssueWire, sessions: readonly SessionMeta[]): boolean {
  return Boolean(issue.draft) && !issue.worktreePath && sessions.length > 0
}

// ---------------------------------------------------------------------------
// What the human is being asked to decide.
// ---------------------------------------------------------------------------

/** When the issue finished: closedAt when stamped (stable — moves only on
 *  closed-predicate flips), else updatedAt for legacy rows. [spec:SP-6144]
 *
 *  Published (not private, as it was inside derive.ts) because the worklist's
 *  closed fold and waiting-age stamp both anchor on it. */
export function issueFinishedAt(issue: Pick<IssueWire, 'closedAt' | 'updatedAt'>): number {
  return Date.parse(issue.closedAt ?? issue.updatedAt) || 0
}

/** Closed human work at the top of an issue tree remains addressable in the
 * sidebar's project-local disclosure until it is explicitly archived. This is
 * deliberately narrower than `stage === 'done'`: done children keep the
 * acknowledgment decay introduced by POD-100. */
export function isClosedTopLevelIssue(
  issue: Pick<IssueWire, 'closedReason' | 'parentId' | 'audience'>,
): boolean {
  return issue.closedReason != null && !issue.parentId && issue.audience === 'human'
}

/** A private issue branch holding work that never landed on its parent branch.
 *  The explicit ahead check keeps a never-moved/empty branch out, while
 *  `merged !== true` reuses the cleanup guard's ancestry verdict.
 *  Unknown/computing git state stays conservative (not actionable). */
function issueHasUnmergedDelivery(issue: IssueWire): boolean {
  const git = issue.gitState
  return Boolean(issue.branch) && git?.shared === false && git.merged !== true && (git.ahead ?? 0) > 0
}

/** A FINISHED issue whose branch still has unlanded work. */
export function issueAwaitingMerge(issue: IssueWire): boolean {
  const finished = issue.stage === 'done' || issue.closedReason != null
  return finished && issueHasUnmergedDelivery(issue)
}

/** What the human is actually being asked to decide (POD-279). A queue of
 *  review-stage issues is not one undifferentiated "needs you": most of them
 *  are a branch waiting to land, and saying so is the difference between
 *  reading nine rows and reading one word.
 *
 *   - `merge`  — the deliverable is commits on a private branch that never
 *                reached `parentBranch`. The decision IS the merge.
 *   - `review` — the issue sits in review with nothing to land (a design, doc
 *                or artifact deliverable, or work already merged): the decision
 *                is approve / send back.
 *
 *  Deliberately derived from stage + git, never from the session offer: an
 *  offer is consumed by any user turn into that session, so a merge queue that
 *  depended on it would silently empty itself (same reasoning as the tray's
 *  review backstop, POD-118). */
export type IssuePendingDecision = 'merge' | 'review'

export function issuePendingDecision(issue: IssueWire): IssuePendingDecision | null {
  const finished = issue.stage === 'done' || issue.closedReason != null
  if (!finished && issue.stage !== 'review') return null
  if (issueHasUnmergedDelivery(issue)) return 'merge'
  // A finished issue with nothing to land is simply done — only an explicit
  // review stage still holds an open question.
  return issue.stage === 'review' ? 'review' : null
}

/** How many commits the merge would land — the one number that makes "ready to
 *  merge" a fact instead of a label. Absent unless the decision is a merge. */
export function issuePendingMergeCommits(issue: IssueWire): number {
  return issuePendingDecision(issue) === 'merge' ? (issue.gitState?.ahead ?? 0) : 0
}

/** The row's copy for a pending decision, in the handoff's terse grammar
 *  ("needs answer", "plan ready"). A merge carries the size of the decision as
 *  a bare count: a sidebar row is ~250px and "· 2 commits" truncates, while
 *  "· 2" under a branch glyph reads as commits. {@link pendingDecisionTitle}
 *  spells it out on hover. */
export function pendingDecisionLabel(
  issue: IssueWire,
  decision: IssuePendingDecision = 'review',
): string {
  if (decision !== 'merge') return 'needs review'
  const commits = issuePendingMergeCommits(issue)
  return commits > 0 ? `ready to merge · ${commits}` : 'ready to merge'
}

/** The unabbreviated sentence behind {@link pendingDecisionLabel} — hover copy,
 *  and the accessible name where the row has no room to say it. */
export function pendingDecisionTitle(
  issue: IssueWire,
  decision: IssuePendingDecision = 'review',
): string {
  if (decision !== 'merge') return 'Waiting on your review'
  const commits = issuePendingMergeCommits(issue)
  const target = issue.parentBranch || 'its parent branch'
  return commits > 0
    ? `${commits} commit${commits === 1 ? '' : 's'} ready to land on ${target}`
    : `Ready to land on ${target}`
}
