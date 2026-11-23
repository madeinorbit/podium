import type { SessionView } from '@podium/client-core/session-values'
import type { SessionModel } from './models'

/**
 * WHICH SESSION A FLIGHT DECK ROW OPENS ON (desktop flight deck). Opening a
 * task from the sidebar or the phone follows `taskOpenSeat` in client-core,
 * which also honours the session last shown on that task (POD-2432).
 *
 * Contract order: coordinator → lone member → most recently active member →
 * no session. Only open sessions qualify. The pane you happen to be looking at
 * is NOT a preference: it made clicking one task open a different task's
 * session.
 *
 * Callers hand over the pool's session objects, often typed through the
 * wire-shaped `SessionView`; `open` is the model's own answer.
 */
export function defaultSeat<S extends SessionModel | SessionView>(
  sessions: readonly S[],
  coordinatorSessionId: string | null | undefined,
): S | undefined {
  return defaultSeatBy(sessions, coordinatorSessionId, (session) => (session as SessionModel).open)
}

/** {@link defaultSeat} over any session shape that can say whether it is open
 *  (the worklist reference oracle passes its own source records). */
export function defaultSeatBy<S extends { sessionId: string; lastActiveAt: string }>(
  sessions: readonly S[],
  coordinatorSessionId: string | null | undefined,
  isOpen: (session: S) => boolean,
): S | undefined {
  const active = sessions.filter(isOpen)
  return (
    active.find((session) => session.sessionId === coordinatorSessionId) ??
    (active.length === 1 ? active[0] : undefined) ??
    [...active].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]
  )
}
