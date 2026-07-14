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

import { type AnyRef, parseAnyRef } from '@podium/protocol'

/** The minimal issue shape the resolver needs (a structural subset of IssueWire). */
export interface RefIssueLike {
  id: string
  prefix?: string
  seq: number
  displayRef?: string
  title: string
}

/** The minimal session shape the resolver needs (a structural subset of SessionMeta). */
export interface RefSessionLike {
  sessionId: string
  displayRef?: string
  cwd: string
  issueId?: string
  title?: string
  name?: string
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
// Open/close reducer — single miniview at a time (opening one replaces it).
// ---------------------------------------------------------------------------

/** The miniview state: the ref currently shown, or null when closed. */
export type MiniviewState = { ref: string } | null

export type MiniviewAction = { type: 'open'; ref: string } | { type: 'close' }

export function miniviewReducer(_state: MiniviewState, action: MiniviewAction): MiniviewState {
  switch (action.type) {
    case 'open':
      // Only one at a time — opening always replaces whatever was open.
      return { ref: action.ref }
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
