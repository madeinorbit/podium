/**
 * WHY A SESSION IS NOT ON SCREEN — the phone's four answers (POD-332).
 *
 * Under the scoped feed the principal's world can SHRINK: the authority evicts a
 * row that still exists but that this person may no longer see (doc §3.1 ¶2).
 * That is not a deletion, and rendering it as one is the defect
 * `resolveReferent` exists to prevent — ADR 2 D14.1 is explicit that a removal
 * from your VIEW and a tombstone "look identical from a distance and are not".
 *
 * SessionScreen used to answer with one sentence for all of it ("it may have
 * been removed on the server"), which told a person whose access had been
 * revoked that their work was deleted.
 *
 * It lives in its own module so the decision is testable without mounting a
 * terminal pane — and so the mapping is one table rather than a chain of
 * ternaries that a later edit can quietly make inconsistent.
 */
import { type ReferentState, resolveReferent } from '@podium/client-core/viewmodels'
import type { SessionId, SessionMeta } from '@podium/model'

export interface SessionAbsence {
  readonly title: string
  readonly body: string
}

/**
 * The copy per state. Four entries, and `pending` is deliberately TERMINAL
 * prose rather than a loader: `pending` is the only state waiting is correct
 * for, but a replica that keeps no exit record answers `undefined` forever, so
 * a spinner here would be the never-resolves defect the same rule forbids.
 */
export const SESSION_ABSENCE: Record<ReferentState, SessionAbsence> = {
  present: { title: 'Session', body: '' },
  'not-visible': {
    title: 'You do not have access to this session.',
    body: 'It exists, but it has not been shared with you. Ask its owner for access.',
  },
  removed: {
    title: 'Session deleted.',
    body: 'It was removed on the server.',
  },
  pending: {
    title: 'Session not here yet.',
    body: 'It has not arrived on this device. It may appear in a moment.',
  },
}

/**
 * Resolve an absent session to what the screen should say.
 *
 * `exitOf` is the replica's `exitKind('session', id)` — OPTIONAL by contract,
 * because a replica can be a correct read model without tracking exits. Absent
 * means "no exit record", which is `pending`; it must never be read as "still
 * here" or as "deleted".
 */
export function sessionAbsence(
  sessionId: SessionId | undefined,
  session: SessionMeta | undefined,
  exitOf: (id: string) => 'removed' | 'evicted' | undefined,
): SessionAbsence {
  const resolution = resolveReferent(sessionId, () => session, exitOf)
  return SESSION_ABSENCE[resolution.state]
}
