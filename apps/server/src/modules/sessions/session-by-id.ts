import type { SessionId } from '@podium/model'

/**
 * THE BY-ID READ, FOR CALLERS THAT HOLD A NARROW PORT [POD-1646].
 *
 * `listSessions().find((s) => s.sessionId === id)` was spelled at 36 sites.
 * Where the caller holds the sessions service it can call `sessionById`
 * directly; where it holds one of the dozen narrow dep interfaces (steward,
 * issue deps, the message handlers, session-access) it holds this instead.
 *
 * The optional `sessionById` is the same arrangement `listSessionsForIssue`
 * uses (POD-1639) and for the same reason: those interfaces are satisfied by
 * many test fixtures that supply `listSessions` and nothing else. The fallback
 * computes the identical answer — the same predicate, applied after the pass
 * rather than instead of it — so a fixture that never wired the narrow port is
 * slow, not wrong.
 */
export interface SessionByIdPort<T extends { sessionId: string }> {
  listSessions(): T[]
  sessionById?(sessionId: SessionId): T | undefined
}

export function findSessionById<T extends { sessionId: string }>(
  deps: SessionByIdPort<T>,
  sessionId: string,
): T | undefined {
  const narrow = deps.sessionById
  if (narrow) return narrow.call(deps, sessionId as SessionId)
  return deps.listSessions().find((session) => session.sessionId === sessionId)
}
