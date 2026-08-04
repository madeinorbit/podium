/**
 * F2 — WHICH SESSIONS BELONG TO WHAT, and how to read a reference into a world
 * you can only partially see (POD-330).
 *
 * This is a genuine cross-entity derivation (sessions × issues × worktree
 * roots), not a lookup table, and it is the question worklist rows, terminal tab
 * strips and issue pages all ask. One question, one module. It imports no slice,
 * so it cannot participate in an import cycle.
 *
 * PARTIAL WORLD. Under the scoped feed (POD-1077, `docs/multi-user-readiness.md`
 * §3.1) the replica holds only what its principal may SEE, so ADR 4 D7.3's
 * "the client already holds the world" no longer means the whole world. An
 * absent referent has FOUR distinguishable causes and this module is the only
 * place that can tell them apart — every membership helper below otherwise
 * returns `[]` or `null` and collapses all of them into one silence. See
 * {@link resolveReferent}.
 *
 * Platform-neutral: no DOM, no storage, no replica import (the resolver takes
 * lookups as functions, so it is testable and mobile consumes it unchanged).
 */
import {
  buildWorktreeRootIndex,
  type IssueId,
  type IssueWire,
  isHeadlessSession,
  type SessionId,
  type SessionMeta,
  worktreeForCwdIndexed,
} from '@podium/model'

// ---------------------------------------------------------------------------
// Referent resolution over a partial world.
// ---------------------------------------------------------------------------

/**
 * Why a referenced entity is not in front of you.
 *
 * - `present`      — it is here; `value` is set.
 * - `not-visible`  — it was EVICTED from your view. A share was revoked or never
 *                    granted. It still exists; you may not see it. This is NOT a
 *                    deletion, and rendering it as one is the defect this whole
 *                    type exists to prevent (ADR 2 D5 warns that soft-delete and
 *                    tombstone "look identical from a distance and are not" —
 *                    evict is the third member of that family).
 * - `removed`      — it was genuinely deleted. A tombstone.
 * - `pending`      — not here YET: no exit record, so it is still in flight or
 *                    outside the current bootstrap chunk.
 *
 * The two rules consumers must honour, and which the tests enforce:
 *   1. `not-visible` must never render as deleted, and must never fabricate a
 *      placeholder that implies the entity exists in a form you can act on.
 *   2. `pending` must never spin forever. It is the ONLY state a spinner is
 *      correct for, and `not-visible` / `removed` are both terminal.
 */
export type ReferentState = 'present' | 'not-visible' | 'removed' | 'pending'

export interface ReferentResolution<T> {
  readonly state: ReferentState
  /** Set iff `state === 'present'`. Never a synthesised stand-in. */
  readonly value?: T
}

/** What the replica reports for an entity that left: see
 *  `packages/sync/src/replica/types.ts` (`ExitKind`). */
export type ReferentExit = 'removed' | 'evicted'

/**
 * Resolve one reference against a partial world.
 *
 * Deliberately takes plain lookups rather than a Replica: the slices stay
 * platform-neutral and this stays a pure function that tests can drive without
 * a sync kernel. `exitOf` is the replica's `exitKind(entity, id)`.
 *
 * Note the ORDER: presence wins over any exit record. A row that was evicted and
 * later re-granted is present again, and its stale exit record must not make it
 * read as invisible.
 */
export function resolveReferent<T>(
  id: string | undefined | null,
  lookup: (id: string) => T | undefined,
  exitOf: (id: string) => ReferentExit | undefined = () => undefined,
): ReferentResolution<T> {
  // No reference at all is not the same question — nothing was ever pointed at,
  // so there is nothing to be pending on.
  if (id == null || id === '') return { state: 'removed' }
  const value = lookup(id)
  if (value !== undefined) return { state: 'present', value }
  const exit = exitOf(id)
  if (exit === 'evicted') return { state: 'not-visible' }
  if (exit === 'removed') return { state: 'removed' }
  return { state: 'pending' }
}

/** Terminal states never resolve further — a consumer that keeps waiting on one
 *  is the "spin on still-loading" defect. */
export function referentSettled(state: ReferentState): boolean {
  return state !== 'pending'
}

// ---------------------------------------------------------------------------
// Membership index.
// ---------------------------------------------------------------------------

/** Precomputed session ownership for one immutable sidebar snapshot. */
export interface SessionOwnershipIndex {
  sessionsByWorktree: ReadonlyMap<string, readonly SessionMeta[]>
  sessionsByIssue: ReadonlyMap<string, readonly SessionMeta[]>
  sessionById: ReadonlyMap<string, SessionMeta>
}

function appendSession(map: Map<string, SessionMeta[]>, key: string, session: SessionMeta): void {
  const existing = map.get(key)
  if (existing) existing.push(session)
  else map.set(key, [session])
}

/**
 * Resolve cwd containment once per session, then reuse those memberships for
 * every issue and worktree row. This turns sidebar ownership derivation from
 * repeated issue × session × worktree scans into one session × worktree pass.
 *
 * EVICTION SAFETY: this index is rebuilt from whatever rows are present. An
 * evicted session simply is not in `sessions`, so it leaves every membership
 * cleanly — no tombstone entry, no "deleted" marker, and nothing that would
 * make a consumer try to heal a gap that is not a gap.
 */
export function indexSessionOwnership(
  sessions: readonly SessionMeta[],
  issues: readonly IssueWire[],
  allWorktreePaths: readonly string[],
): SessionOwnershipIndex {
  // ONE root index for the whole pass. Building it is O(roots); every session
  // then resolves in O(its path depth) instead of scanning all roots. Before
  // POD-1645 this was sessions × roots — and the root list grows with the ISSUE
  // count, so on the live corpus (~1100 sessions, ~1600 issues) one index build
  // was millions of string comparisons, three times per replica delta.
  const roots = buildWorktreeRootIndex([
    ...allWorktreePaths,
    ...issues.flatMap((issue) => (issue.worktreePath ? [issue.worktreePath] : [])),
  ])
  const issuesByWorktree = new Map<string, IssueWire[]>()
  for (const issue of issues) {
    if (issue.archived || issue.deletedAt || !issue.worktreePath) continue
    const existing = issuesByWorktree.get(issue.worktreePath)
    if (existing) existing.push(issue)
    else issuesByWorktree.set(issue.worktreePath, [issue])
  }
  const sessionsByWorktree = new Map<string, SessionMeta[]>()
  const sessionsByIssue = new Map<string, SessionMeta[]>()
  const sessionById = new Map<string, SessionMeta>()
  for (const session of sessions) {
    if (session.archived || isHeadlessSession(session)) continue
    sessionById.set(session.sessionId, session)
    const worktreePath = worktreeForCwdIndexed(session.cwd, roots)
    if (worktreePath) appendSession(sessionsByWorktree, worktreePath, session)
    if (session.issueId !== undefined) {
      appendSession(sessionsByIssue, session.issueId, session)
      continue
    }
    if (!worktreePath) continue
    for (const issue of issuesByWorktree.get(worktreePath) ?? []) {
      appendSession(sessionsByIssue, issue.id, session)
    }
  }
  return { sessionsByWorktree, sessionsByIssue, sessionById }
}

/** Sessions shown in a worktree's tab strip / sidebar — archived ones stay out.
 *  With `allWorktreePaths`, membership is by CONTAINMENT (worktreeForCwd), so a
 *  session whose stamped cwd is a subdirectory of the worktree still shows in it
 *  instead of vanishing from every group. Without it, legacy exact-match. */
export function sessionsForWorktree(
  sessions: SessionMeta[],
  worktreePath: string,
  allWorktreePaths?: string[],
  ownership?: SessionOwnershipIndex,
): SessionMeta[] {
  if (allWorktreePaths && ownership) {
    return [...(ownership.sessionsByWorktree.get(worktreePath) ?? [])]
  }
  // One root index for the whole filter, not one scan per session.
  const roots = allWorktreePaths ? buildWorktreeRootIndex(allWorktreePaths) : null
  return sessions.filter(
    (s) =>
      !s.archived &&
      !isHeadlessSession(s) &&
      (roots ? worktreeForCwdIndexed(s.cwd, roots) === worktreePath : s.cwd === worktreePath),
  )
}

/** Sessions living in an issue's worktree — exact cwd match or nested under it.
 *  Mirrors the server's sessionsForIssue membership so the sidebar count stays
 *  live between issuesChanged broadcasts. */
export function sessionsForIssueWorktree(
  sessions: SessionMeta[],
  worktreePath: string | null,
): SessionMeta[] {
  if (!worktreePath) return []
  return sessions.filter(
    (s) =>
      !isHeadlessSession(s) && (s.cwd === worktreePath || s.cwd.startsWith(`${worktreePath}/`)),
  )
}

/** The shape an issue must have to answer membership questions — deliberately
 *  the minimum, so this module never depends on the worklist's nav model. */
export interface IssueMembershipRef {
  id: IssueId
  worktreePath: string | null
  memberSessionIds?: string[]
}

/** Explicit-attachment-first session grouping for an issue row (issue-as-workspace):
 *  sessions with `issueId === issue.id` are first-class members; sessions with NO
 *  issueId fall back to cwd containment in the issue's worktree (legacy). A session
 *  attached to a DIFFERENT issue never shows here even if its cwd is contained.
 *  Archived + headless sessions are always excluded; shells are excluded by default
 *  (sidebar policy) — the workspace tab strip opts them back in. */
export function sessionsForIssueNav(
  issue: IssueMembershipRef,
  sessions: SessionMeta[],
  allWorktreePaths: string[],
  opts: { includeShells?: boolean } = {},
  ownership?: SessionOwnershipIndex,
): SessionMeta[] {
  if (ownership) {
    const members = ownership.sessionsByIssue.get(issue.id) ?? []
    return opts.includeShells ? [...members] : members.filter((s) => s.agentKind !== 'shell')
  }
  const memberIds = issue.memberSessionIds
  if (memberIds !== undefined) {
    const ids = new Set(memberIds)
    return sessions.filter((s) => {
      if (s.archived || isHeadlessSession(s)) return false
      if (!opts.includeShells && s.agentKind === 'shell') return false
      return ids.has(s.sessionId)
    })
  }
  const wt = issue.worktreePath
  // Longest-match containment needs the full root list (a repo root contains its
  // own .worktrees/* checkouts); make sure the issue's own worktree is in it.
  const roots = buildWorktreeRootIndex(wt ? [...allWorktreePaths, wt] : allWorktreePaths)
  return sessions.filter((s) => {
    if (s.archived || isHeadlessSession(s)) return false
    if (!opts.includeShells && s.agentKind === 'shell') return false
    if (s.issueId !== undefined) return s.issueId === issue.id
    if (!wt) return false
    return worktreeForCwdIndexed(s.cwd, roots) === wt
  })
}

/** The ARCHIVED members of an issue — same membership rule as
 *  {@link sessionsForIssueNav} (explicit `issueId` first, else cwd containment)
 *  but inverted on `archived`. Drives the tab strip's "N archived" reveal so a
 *  hidden-away session stays reopenable. Headless sessions never count. */
export function archivedSessionsForIssue(
  issue: IssueMembershipRef,
  sessions: SessionMeta[],
  allWorktreePaths: string[],
): SessionMeta[] {
  const memberIds = issue.memberSessionIds
  if (memberIds !== undefined) {
    const ids = new Set(memberIds)
    return sessions.filter((s) => s.archived && !isHeadlessSession(s) && ids.has(s.sessionId))
  }
  const wt = issue.worktreePath
  const roots = buildWorktreeRootIndex(wt ? [...allWorktreePaths, wt] : allWorktreePaths)
  return sessions.filter((s) => {
    if (!s.archived || isHeadlessSession(s)) return false
    if (s.issueId !== undefined) return s.issueId === issue.id
    if (!wt) return false
    return worktreeForCwdIndexed(s.cwd, roots) === wt
  })
}

/** The ARCHIVED sessions contained in a worktree path — the inverse of
 *  {@link sessionsForWorktree} on `archived`, for the tab strip's reveal. */
export function archivedSessionsForWorktreePath(
  sessions: SessionMeta[],
  worktreePath: string,
  allWorktreePaths?: string[],
): SessionMeta[] {
  const roots = allWorktreePaths ? buildWorktreeRootIndex(allWorktreePaths) : null
  return sessions.filter(
    (s) =>
      s.archived &&
      !isHeadlessSession(s) &&
      (roots ? worktreeForCwdIndexed(s.cwd, roots) === worktreePath : s.cwd === worktreePath),
  )
}

/**
 * Resolve which issue (among `issues`) owns `sessionId`: explicit `issueId`
 * first, else cwd containment via {@link sessionsForIssueNav}. Null when the
 * session or its issue is not in the given sets (sidebar fallback: top-level).
 *
 * Null here means "not resolvable from what you can see", which under scoping
 * includes "the owning issue is not visible to you". Callers that must tell that
 * apart from "no owner" use {@link resolveReferent} on the session's `issueId`.
 */
export function issueIdOwningSession(
  sessionId: SessionId,
  sessions: readonly SessionMeta[],
  issues: readonly IssueWire[],
  allWorktreePaths: string[],
  ownership?: SessionOwnershipIndex,
): IssueId | null {
  if (ownership) {
    const indexed = ownership.sessionById.get(sessionId)
    if (!indexed) return null
    if (indexed.issueId !== undefined) {
      return issues.some(
        (issue) => issue.id === indexed.issueId && !issue.archived && !issue.deletedAt,
      )
        ? indexed.issueId
        : null
    }
    for (const issue of issues) {
      if (issue.archived || issue.deletedAt) continue
      if (
        ownership.sessionsByIssue.get(issue.id)?.some((member) => member.sessionId === sessionId)
      ) {
        return issue.id
      }
    }
    return null
  }
  const session = sessions.find((s) => s.sessionId === sessionId)
  if (!session || session.archived || isHeadlessSession(session)) return null
  if (session.issueId !== undefined) {
    return issues.some((i) => i.id === session.issueId && !i.archived && !i.deletedAt)
      ? session.issueId
      : null
  }
  for (const issue of issues) {
    if (issue.archived || issue.deletedAt) continue
    if (sessionsForIssueNav(issue, [session], allWorktreePaths).length > 0) return issue.id
  }
  return null
}
