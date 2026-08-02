/**
 * F3 — *what order sessions are presented in.*
 *
 * The third named shared derivation (POD-330). Not a helpers bag: it answers
 * exactly one question and never departs from its shape.
 *
 * The invariant has TWO clauses, and only one of them is mechanically
 * checkable. Both must hold before a symbol belongs here.
 *
 *   SHAPE (checkable): **a collection of sessions in, an order or a rank out.**
 *   No issues, no rows, no repos, no presentation strings. It depends on
 *   `@podium/model` and `../focus` and on nothing else in `viewmodels/`, so it
 *   cannot participate in a cycle.
 *
 *   QUESTION (not checkable): **what order sessions are presented in** —
 *   whether that order is decided by COMPARING the sessions
 *   (`sortSessionsForSidebar`, `sessionUrgencyRank`, `mostUrgentSession`) or by
 *   HONOURING AN EXTERNAL DESIGNATION (`elevateCoordinatorSession`, whose key
 *   is an id handed in, not a property of the sessions being ordered).
 *
 * That second paragraph of the question clause was widened deliberately in
 * POD-1503, when `elevateCoordinatorSession` moved here and satisfied the shape
 * clause verbatim while the original question — "how sessions RANK AGAINST EACH
 * OTHER" — did not describe it. The sentence is what arbitrates the NEXT
 * symbol, so a stated question that no longer describes the contents is worse
 * than a module over its line budget: the next candidate gets argued against
 * what the file SAYS, not against what anyone meant.
 *
 * A SHAPE PREDICATE IS NECESSARY, NOT SUFFICIENT. It refuses a symbol whose
 * shape is wrong — that is how `isCoordinatorSession` was refused here on sight,
 * for taking an `IssueWire`. It cannot refuse one whose shape is right and whose
 * question is foreign, and that is the drift that actually produces god objects,
 * because nobody ever adds a symbol that LOOKS wrong. (POD-330, map §4e.1,
 * b9b39289.)
 *
 * It exists because the census that produced the ownership map counted only
 * EXTERNAL consumers, and `sortSessionsForSidebar` has none outside tests — its
 * real callers are `issueNavList` (issues) and `sidebarSections` (worklist),
 * both INSIDE the file being cut. Left where it looked like it lived, it would
 * have made `issues -> worklist` an edge on top of the known `worklist ->
 * issues` one: a cycle, arrived at by not looking inside the file.
 *
 * F1 (`session-status.ts`) cannot hold it — F1's invariant is one session in,
 * one presentation value out, with no collections and no ordering. Ranking IS
 * the collection question, and it is a different question from membership (F2).
 */
import { isSnoozed, type SessionMeta } from '@podium/model'
import { attentionGroup, compareRecency } from '../focus'

/** How long a session may sit quiet before the unified list calls it stale. */
export const STALE_INACTIVE_MS = 16 * 60 * 60 * 1000

/**
 * Sidebar session order: non-snoozed attention first, then snoozed attention
 * (de-emphasised), then working sessions at the bottom. Within each rank,
 * most-recently-active first.
 */
export function sortSessionsForSidebar(
  sessions: SessionMeta[],
  now: number = Date.now(),
): SessionMeta[] {
  // Rank 0 = needs-you/idle and not snoozed (top); 1 = attention but snoozed
  // (de-emphasised, just above working); 2 = working (bottom).
  const rank = (s: SessionMeta): number => {
    if (attentionGroup(s) === 'working') return 2
    return isSnoozed(s, now) ? 1 : 0
  }
  return [...sessions].sort((a, b) => {
    const dr = rank(a) - rank(b)
    if (dr !== 0) return dr
    return compareRecency(a, b, now)
  })
}

/**
 * Urgency rank of one session for the unified WORK list ordering:
 *   0 — needs the human NOW (attention state, not snoozed, process still around)
 *   1 — working (running fine without us)
 *   2 — ready/idle and recently active
 *   3 — stale (long-quiet), exited, or otherwise dormant
 * Built on the same primitives every other surface uses (attentionGroup,
 * isSnoozed, STALE_INACTIVE_MS) so "urgent" means the same thing everywhere.
 */
export function sessionUrgencyRank(s: SessionMeta, now: number): number {
  const group = attentionGroup(s)
  if (group === 'working') return 1
  const recent = now - Date.parse(s.lastActiveAt) <= STALE_INACTIVE_MS
  // Anything non-working that classic counted as attention — a blocked agent OR
  // a just-FINISHED one (idle/done) — floats above working, exactly like the old
  // NEEDS YOUR ATTENTION section did. Snoozed sessions are muted to rank 2; only
  // long-quiet or exited sessions sink to stale.
  if (!isSnoozed(s, now) && s.status !== 'exited' && recent) return 0
  return recent && s.status !== 'exited' ? 2 : 3
}

/** The row's most urgent child session (lowest urgency rank, recency tiebreak) —
 *  drives the row's right-side status dot. Undefined for session-less rows. */
export function mostUrgentSession(
  sessions: SessionMeta[],
  now: number = Date.now(),
): SessionMeta | undefined {
  let best: SessionMeta | undefined
  for (const s of sessions) {
    if (!best) {
      best = s
      continue
    }
    const dr = sessionUrgencyRank(s, now) - sessionUrgencyRank(best, now)
    if (dr < 0 || (dr === 0 && compareRecency(s, best, now) < 0)) best = s
  }
  return best
}

/**
 * Move the designated coordinator session to the front of an issue's session
 * list (M6 / docs/agent-comms-target.html §05 q1). No-op when unset or when
 * the coordinator is not among the listed sessions (dangling-tolerant).
 *
 * POD-1503: this lived in the TERMINAL slice until POD-330's review of
 * POD-1496, because the tab strip was its first caller. It never belonged
 * there. It is *sessions in, an order out* — this module's stated invariant,
 * verbatim — so terminal's tab order and the worklist's row construction were
 * both reaching across a slice boundary for an ordering primitive. Moving it
 * here does not document the `worklist -> terminal` edge; it DELETES it.
 *
 * Its sibling `isCoordinatorSession` deliberately stayed in terminal: it takes
 * an `IssueWire`, and this module's invariant ("no issues") refuses it on
 * sight. That is the invariant doing its job — a module with a stated shape can
 * claim or refuse a symbol without anyone arbitrating.
 */
export function elevateCoordinatorSession(
  sessions: SessionMeta[],
  coordinatorSessionId: string | undefined | null,
): SessionMeta[] {
  if (!coordinatorSessionId) return sessions
  const i = sessions.findIndex((s) => s.sessionId === coordinatorSessionId)
  if (i <= 0) return sessions
  const next = sessions.slice()
  const [coord] = next.splice(i, 1)
  if (!coord) return sessions
  next.unshift(coord)
  return next
}
