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
import type { SessionIdentifierResolution } from '@podium/protocol'

/** The replica's four answers, plus what the SERVER said about a link the
 *  replica could not answer (POD-4637). */
export type SessionAbsenceState = ReferentState | 'resolving' | 'ambiguous' | 'not-found'

export interface SessionAbsence {
  readonly state: SessionAbsenceState
  readonly title: string
  readonly body: string
}

/**
 * The copy per state. A `pending` row may also wear a loader while the local
 * optimistic-spawn set proves that a launch is in flight. The copy itself stays
 * complete because an arbitrary absent route can remain `pending` forever when
 * a replica does not retain exit records.
 */
export const SESSION_ABSENCE: Record<ReferentState, SessionAbsence> = {
  present: { state: 'present', title: 'Session', body: '' },
  'not-visible': {
    state: 'not-visible',
    title: 'You do not have access to this session.',
    body: 'It exists, but it has not been shared with you. Ask its owner for access.',
  },
  removed: {
    state: 'removed',
    title: 'Session deleted.',
    body: 'It was removed on the server.',
  },
  pending: {
    state: 'pending',
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

/**
 * THE LINK'S ANSWER (POD-4637). The replica can only say "pending" about an id
 * it does not hold — and for a short id (`/session/214a3887`) that meant "not
 * here yet" about a live session, forever. When the replica says pending, the
 * server's answer (`useSessionLink`) decides instead:
 *
 *  - still asking about a SHORT id ⇒ "Opening session…", never "not here yet";
 *    a full id keeps the pending copy while asking, since it may be arriving;
 *  - ambiguous ⇒ says so, with the CLI's own message naming the candidates;
 *  - absent ⇒ "Session not found." — the server is the authority.
 *
 * A settled replica answer (deleted, no access) is more specific than the
 * server's and is kept. A `session` answer navigates, so it renders as pending.
 */
export function sessionLinkAbsence(
  replica: SessionAbsence,
  link: SessionLinkState,
  shortId: boolean,
): SessionAbsence {
  if (replica.state !== 'pending') return replica
  switch (link.kind) {
    case 'resolving':
      return shortId ? SESSION_LINK_RESOLVING : replica
    case 'ambiguous':
      return { state: 'ambiguous', title: 'Several sessions match this link.', body: link.message }
    case 'absent':
      return SESSION_NOT_FOUND
    default:
      return replica
  }
}

export const SESSION_LINK_RESOLVING: SessionAbsence = {
  state: 'resolving',
  title: 'Opening session…',
  body: '',
}

export const SESSION_NOT_FOUND: SessionAbsence = {
  state: 'not-found',
  title: 'Session not found.',
  body: 'No session you can see matches this link.',
}

/** What the server said about the route's id; `idle` when nobody asked. */
export type SessionLinkState =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | SessionIdentifierResolution

/** Motion is licensed by a real spawn in flight, not absence by itself. */
export function sessionAbsenceShowsLoader(absence: SessionAbsence, spawnPending: boolean): boolean {
  if (absence.state === 'resolving') return true
  return absence.state === 'pending' && spawnPending
}
