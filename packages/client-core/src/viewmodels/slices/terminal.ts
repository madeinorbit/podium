/**
 * TERMINAL SLICE (POD-330) — the workspace: which session a pane shows, what
 * order the tab strip is in, and what happens to panes when a worktree moves
 * out from under them.
 *
 * Boundary: everything here is about the SESSIONS THE USER IS LOOKING AT — a
 * pane, a tab strip, a worktree's orphans. Nothing here decides what appears in
 * the sidebar. The first attempt at this cut landed the SIDEBAR under terminal,
 * which is the ownership question never being asked; `sidebarSessions` and
 * `sidebarSections` stay with the worklist for that reason.
 *
 * PARTIAL WORLD. Every function here is dangling-tolerant BY CONSTRUCTION, and
 * that is now a requirement rather than a nicety: under the scoped feed a
 * referenced session may be absent because it is INVISIBLE (evicted when a
 * share was revoked), not only because it is late or deleted.
 *   - a coordinator id that names no listed session is a no-op, not an error;
 *   - a pane pointing at a session that left simply re-picks;
 *   - a session that leaves the replica leaves the tab strip with no tombstone,
 *     no removal state and nothing to heal.
 * `elevateCoordinatorSession` and `pickPaneSession` deliberately answer only
 * "which of THESE sessions" — they never resolve an id against the world, so
 * they cannot fabricate a placeholder for one they cannot see. A caller that
 * needs to tell the three absences apart uses `resolveReferent` (F2).
 *
 * Depends on F1 and F2. Imports no other slice.
 * Platform-neutral: no DOM, no storage.
 */
import { worktreeForCwd, type IssueWire, type SessionId, type SessionMeta } from '@podium/model'
import { sessionsForWorktree } from '../session-ownership'
// POD-1503: coordinator elevation is an ORDERING question, so it lives in F3
// (session-urgency), not here — the tab strip was merely its first caller.
import { elevateCoordinatorSession } from '../session-urgency'

// ---------------------------------------------------------------------------
// Tab strip order.
// ---------------------------------------------------------------------------

/** Position lookup for a saved manual order.
 *
 *  Deliberately NOT shared with the worklist's row ordering, which builds the
 *  same map from a different list: a tab order and a row order are two separate
 *  pieces of user state that never have to agree, and a shared helper would be
 *  the seam where someone later makes them agree by accident. The duplication is
 *  four lines of mechanism, not a shared decision. */
function orderMap(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]))
}

/**
 * Tab-strip order for one worktree/issue. The user's manual (drag) order wins;
 * sessions it doesn't know about — panels opened after the last drag — append
 * at the end in arrival order. When `coordinatorSessionId` is set (issue
 * workspace, M6), that session is elevated first so the driver is unambiguous
 * among equal tabs. (Panel-pinning is retired, POD-169 — no pin-aware order.)
 */
export function orderTabs(
  sessions: SessionMeta[],
  manualOrder: string[] | undefined,
  coordinatorSessionId?: string | null,
): SessionMeta[] {
  const base = elevateCoordinatorSession(sessions, coordinatorSessionId)
  if (!manualOrder || manualOrder.length === 0) return base
  // Manual drag order wins, but still lift the coordinator to the front so a
  // stale saved order can't bury the designated driver.
  const position = orderMap(manualOrder)
  const known = base
    .filter((s) => position.has(s.sessionId))
    .sort((a, b) => (position.get(a.sessionId) ?? 0) - (position.get(b.sessionId) ?? 0))
  const unknown = base.filter((s) => !position.has(s.sessionId))
  return elevateCoordinatorSession([...known, ...unknown], coordinatorSessionId)
}

/** True when this session is the issue's designated coordinator (M6). */
export function isCoordinatorSession(
  issue: Pick<IssueWire, 'coordinatorSessionId'>,
  sessionId: SessionId,
): boolean {
  return typeof issue.coordinatorSessionId === 'string' && issue.coordinatorSessionId === sessionId
}

// ---------------------------------------------------------------------------
// Pane targeting.
// ---------------------------------------------------------------------------

/** Pane target when a sidebar issue/worktree row is clicked: keep the current
 *  pane if it's already one of the row's members (a session in `members` or an
 *  id in `extraValidIds` — e.g. the row's open file tabs); otherwise open the
 *  row's most recently active session (lastActiveAt, ISO-comparable). Null =
 *  nothing to open (empty row) — clear the pane so the picker shows. */
export function pickPaneSession(
  members: SessionMeta[],
  paneA: SessionId | null,
  /** File-tab ids, which are NOT session ids — hence the plain string here. */
  extraValidIds: readonly string[] = [],
): SessionId | null {
  if (
    paneA != null &&
    (members.some((s) => s.sessionId === paneA) || extraValidIds.includes(paneA))
  ) {
    return paneA
  }
  let best: SessionMeta | null = null
  for (const s of members) if (!best || s.lastActiveAt > best.lastActiveAt) best = s
  return best?.sessionId ?? null
}

/** When the selected path no longer resolves to a live worktree but still has
 *  sessions pinned to it (its worktree was removed out from under them), pick
 *  which orphan to surface in the workspace: the one already in pane A if it's
 *  one of them, else the first. Null when there's nothing to show — so the
 *  caller falls back to the empty "Select a worktree." placeholder. */
export function orphanSessionFor(opts: {
  selectedWorktree: string | null
  sessions: SessionMeta[]
  paneA: string | null
}): SessionMeta | null {
  if (!opts.selectedWorktree) return null
  // Containment against just the selected path: the worktree is gone from the
  // scan, so there's no root list to resolve against — but a session stamped
  // with a subdirectory of the removed worktree is still its orphan.
  const orphans = sessionsForWorktree(opts.sessions, opts.selectedWorktree, [opts.selectedWorktree])
  return orphans.find((s) => s.sessionId === opts.paneA) ?? orphans[0] ?? null
}

// ---------------------------------------------------------------------------
// Worktree moves.
// ---------------------------------------------------------------------------

/** One session's worktree change, as seen between two `sessions` snapshots. */
export interface WorktreeMove {
  sessionId: SessionId
  from: string | null
  to: string | null
}

/**
 * View policy for sessions whose worktree changed: the session the user is
 * looking at FOLLOWS (switch the whole view to its new worktree so it doesn't
 * vanish out of the tab strip mid-conversation); a background session's move
 * never yanks the view — it's reported (`moved`) for a toast instead.
 *
 * `follow` is non-null only when a visible-pane session moved OUT of the
 * currently-selected worktree into another known worktree. Moves are computed
 * on resolved worktree roots (worktreeForCwd), so a subdirectory cd is a no-op,
 * and first-sight sessions (no previous cwd) are never moves.
 *
 * A session that LEFT the replica between the two snapshots is not in
 * `sessions` and therefore produces no move at all — an eviction is not a
 * relocation, and must not raise a "moved to nowhere" toast.
 */
export function planWorktreeMoves(opts: {
  prevCwds: Record<string, string>
  sessions: SessionMeta[]
  worktreePaths: string[]
  selectedWorktree: string | null
  visiblePanes: string[]
}): { follow: string | null; moved: WorktreeMove[] } {
  let follow: string | null = null
  const moved: WorktreeMove[] = []
  for (const s of opts.sessions) {
    const prev = opts.prevCwds[s.sessionId]
    if (prev === undefined || prev === s.cwd) continue
    const from = worktreeForCwd(prev, opts.worktreePaths)
    const to = worktreeForCwd(s.cwd, opts.worktreePaths)
    if (from === to) continue // subdirectory cd / unresolvable churn — not a move
    if (
      follow === null &&
      to !== null &&
      from !== null &&
      from === opts.selectedWorktree &&
      opts.visiblePanes.includes(s.sessionId)
    ) {
      follow = to
    } else {
      moved.push({ sessionId: s.sessionId, from, to })
    }
  }
  return { follow, moved }
}
