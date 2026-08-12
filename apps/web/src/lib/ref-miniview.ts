/**
 * Pure resolution + state for the floating ref miniview (#474, area 7).
 *
 * A ref link (from markdown linkify or the terminal link provider) carries a
 * `data-ref` token like `POD-13`, `POD-13-A`, or `POD-DRAFT-3`. This module
 * turns that token — plus the store's live issues/sessions — into a concrete
 * target, and owns the tiny open/close reducer for the single-instance miniview.
 *
 * Kept dependency-free (besides the shared ref grammar) so it is unit-testable
 * without React or the store.
 */

import type { IssuePanelArtifact, IssuePanelTodo, IssueWire, SessionId, IssueId } from '@podium/model'
import { type AnyRef, parseAnyRef } from '@podium/protocol'

/**
 * The issue shape the resolver needs and the miniview card renders — COMPOSED
 * from `IssueWire` rather than restated (POD-367; POD-364's inventory #12 called
 * this the largest client-side restatement in the repo, 22 keys).
 *
 * Identity is required; the at-a-glance fields stay optional, which is the one
 * thing this projection legitimately changes about them — a lean fixture or a
 * legacy row must still fit. That is `Partial<Pick<…>>`, so the optionality is
 * declared once here instead of field by field, and every field's TYPE now comes
 * from the aggregate: when `IssueWire.stage` gains a stage or `id` gains a brand,
 * this shape follows instead of drifting.
 */
export type RefIssueLike = Pick<IssueWire, 'id' | 'seq' | 'title'> &
  Partial<
    Pick<
      IssueWire,
      | 'prefix'
      | 'displayRef'
      | 'stage'
      | 'priority'
      | 'assignee'
      | 'ready'
      | 'blocked'
      | 'blockedByNotes'
      | 'childCount'
      | 'childDoneCount'
      | 'parentId'
      | 'description'
      | 'activityNotes'
      | 'notesUpdatedAt'
      | 'commentCount'
      // Membership, for the card's "Go to session" action: the designated
      // coordinator wins over the merely-most-recent member.
      | 'coordinatorSessionId'
      // Startability fields for the card's "Run now" action (POD-110) — the same
      // structural subset `isIssueStartable` reads off IssueWire.
      | 'worktreePath'
      | 'defaultAgent'
      | 'closedReason'
      | 'archived'
      | 'deletedAt'
    >
  > & {
    /**
     * The card renders a genuinely NARROWER panel than the wire carries — two of
     * the three groups, and only two members of an artifact. That narrowing is
     * legitimate (ADR 4: a projection reads what it renders), so it stays; what
     * does not stay is restating `{ text, done }` and `{ path, title }` by hand.
     * The member types come from the panel group itself.
     */
    panel?: {
      todos?: readonly IssuePanelTodo[]
      artifacts?: readonly Pick<IssuePanelArtifact, 'path' | 'title'>[]
    }
  }

/** The minimal session shape the resolver needs (a structural subset of SessionMeta). */
export interface RefSessionLike {
  sessionId: SessionId
  displayRef?: string
  cwd: string
  issueId?: IssueId
  title?: string
  name?: string
  /** Liveness + recency, for {@link sessionForIssue}'s pick. All optional: a
   *  lean fixture or a legacy row still resolves, it just ranks by nothing. */
  archived?: boolean
  status?: string
  lastActiveAt?: string
  agentKind?: string
}

export type ResolvedRef =
  | { kind: 'issue'; ref: AnyRef; issue: RefIssueLike }
  | { kind: 'session'; ref: AnyRef; session: RefSessionLike }

/**
 * Resolve a `data-ref` token to a concrete issue or session, or null when the
 * grammar doesn't parse or nothing in the store matches.
 *
 * - An issue token (`POD-13`) matches an issue by `prefix` + `seq`.
 * - A session token (`POD-13-A` / `POD-DRAFT-3`) matches a session by its
 *   permanent birth `displayRef` (the canonical nice name).
 */
export function resolveRef(
  dataRef: string,
  issues: readonly RefIssueLike[],
  sessions: readonly RefSessionLike[],
): ResolvedRef | null {
  const ref = parseAnyRef(dataRef)
  if (!ref) return null
  if (ref.kind === 'issue') {
    const issue = issues.find((i) => i.prefix === ref.prefix && i.seq === ref.seq)
    return issue ? { kind: 'issue', ref, issue } : null
  }
  // Session: the birth displayRef is the canonical, permanent nice name.
  const session = sessions.find((s) => s.displayRef === dataRef.trim())
  return session ? { kind: 'session', ref, session } : null
}

// ---------------------------------------------------------------------------
// "Go to session" — the chat's other escalation from an issue ref.
// ---------------------------------------------------------------------------

/**
 * The session a ref card's "Go to session" lands on, and the issue it hangs off.
 *
 * `via` is the issue that OWNS the session, which is not always the issue the
 * ref names: a subtask is usually worked inside its parent's session, so a card
 * for a sessionless child hands you the nearest ancestor that has one rather
 * than nothing. `via.id === issue.id` means the task runs its own session.
 */
export interface IssueSessionTarget {
  session: RefSessionLike
  via: RefIssueLike
}

/** Still present: an exited-but-unarchived session is gone, and offering it
 *  would promise a live agent where there is none. Same predicate the dock
 *  and the Flight Deck count with. */
function isLiveSession(session: RefSessionLike): boolean {
  return !session.archived && session.status !== 'exited' && session.agentKind !== 'shell'
}

/** Contract order, matching the dock's session roster: the designated
 *  coordinator, then the most recently active member. */
function pickSession(
  issue: RefIssueLike,
  sessions: readonly RefSessionLike[],
): RefSessionLike | null {
  const mine = sessions.filter((s) => s.issueId === issue.id && isLiveSession(s))
  if (mine.length === 0) return null
  const coordinator = issue.coordinatorSessionId
    ? mine.find((s) => s.sessionId === issue.coordinatorSessionId)
    : undefined
  return (
    coordinator ??
    [...mine].sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))[0] ??
    null
  )
}

/**
 * Where "Go to session" goes for an issue: its own live session, else the
 * nearest ancestor's — a subtask carries no session of its own, and the work on
 * it is happening in the parent that does.
 *
 * Returns null when nothing in the chain has run, in which case the card offers
 * no session action at all rather than a button that goes nowhere. The walk is
 * bounded by the visited set, so a cyclic `parentId` terminates.
 */
export function sessionForIssue(
  issue: RefIssueLike,
  issues: readonly RefIssueLike[],
  sessions: readonly RefSessionLike[],
): IssueSessionTarget | null {
  const seen = new Set<string>()
  let node: RefIssueLike | undefined = issue
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    const session = pickSession(node, sessions)
    if (session) return { session, via: node }
    const parentId: string | undefined = node.parentId
    node = parentId ? issues.find((i) => i.id === parentId) : undefined
  }
  return null
}

// ---------------------------------------------------------------------------
// Open/close reducer — single miniview at a time (opening one replaces it).
// ---------------------------------------------------------------------------

/** Viewport point (clientX/clientY) of the click that opened the miniview. */
export interface MiniviewAnchor {
  x: number
  y: number
}

/**
 * The miniview state: the ref currently shown, or null when closed. `anchor` is
 * where the activating click landed (absent for non-pointer activations — the
 * card then falls back to a fixed seed). `seq` increments on every open so the
 * card re-seeds its position per activation, even for the same ref.
 */
export type MiniviewState = { ref: string; anchor?: MiniviewAnchor; seq: number } | null

export type MiniviewAction =
  | { type: 'open'; ref: string; anchor?: MiniviewAnchor }
  | { type: 'close' }

export function miniviewReducer(state: MiniviewState, action: MiniviewAction): MiniviewState {
  switch (action.type) {
    case 'open':
      // Only one at a time — opening always replaces whatever was open.
      return { ref: action.ref, anchor: action.anchor, seq: (state?.seq ?? 0) + 1 }
    case 'close':
      return null
  }
}

// ---------------------------------------------------------------------------
// Known-prefix derivation (drives markdown + terminal linkify activation).
// ---------------------------------------------------------------------------

/**
 * The set of registered repo prefixes across any prefix-bearing rows (#474).
 * The canonical source is `repos.listDetailed` (a repo with zero issues must
 * still linkify); issue rows are unioned in as a cheap freshness fallback —
 * pass both lists concatenated.
 */
export function collectRefPrefixes(
  ...rowLists: readonly (readonly { prefix?: string | null }[])[]
): Set<string> {
  const out = new Set<string>()
  for (const rows of rowLists) for (const r of rows) if (r.prefix) out.add(r.prefix)
  return out
}

// ---------------------------------------------------------------------------
// Session "working <issue>" context chip (#474 review, finding 9).
// ---------------------------------------------------------------------------

/**
 * The display ref of the issue a session is CURRENTLY attached to, when it
 * differs from the issue baked into the session's birth `displayRef` — e.g. a
 * `POD-13-A` session re-homed onto POD-27 yields `'POD-27'`. Returns null when
 * there is no current issue, it has no displayRef, or it is the birth issue
 * (nothing extra to say).
 */
export function sessionWorkingIssueRef(
  session: Pick<RefSessionLike, 'displayRef' | 'issueId'>,
  issues: readonly RefIssueLike[],
): string | null {
  if (!session.issueId) return null
  const current = issues.find((i) => i.id === session.issueId)
  if (!current?.displayRef) return null
  const birth = session.displayRef ? parseAnyRef(session.displayRef) : null
  if (birth && birth.kind === 'session' && birth.seq !== undefined) {
    const birthIssueRef = `${birth.prefix}-${birth.seq}`
    if (birthIssueRef === current.displayRef) return null
  }
  return current.displayRef
}
