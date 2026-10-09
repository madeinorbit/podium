/** The reference card's old catalog answers (POD-5831), kept only as the
 * comparison oracle for the shared IssueModel/SessionModel answers. */
import { parseAnyRef } from '@podium/protocol'
import type { RefIssueLike, RefSessionLike, ResolvedRef } from './ref-miniview'

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
