import type { SessionView } from '@podium/client-core/session-values'
import { type IssueNavigationModel, taskOpenSeat } from '@podium/client-core/values'
import type { SessionId } from '@podium/model'

/** Where a tap on the flight deck page goes. */
export type DeckOpen =
  /** Show this session on the chat page and page back to it. */
  | { kind: 'chat'; sessionId: SessionId }
  /** Leave the pager for another screen. */
  | { kind: 'push'; href: string }

/** The slice of the shared mission screen a deck tap reads. */
export interface DeckSeats {
  full: { task(id: string): { sessionIds: readonly string[] } }
  pool: { sessionObject(id: string): unknown }
}

/**
 * A session row opens that session on the chat page while it belongs to this
 * mission's crew, which is everything the deck lists. Anything else (a seat the
 * crew lost between render and tap) opens its own mission chat.
 */
export function deckSessionOpen(
  missionId: string,
  sessionId: SessionId,
  crew: readonly SessionView[],
): DeckOpen {
  return crew.some((session) => session.sessionId === sessionId)
    ? { kind: 'chat', sessionId }
    : { kind: 'push', href: missionHref(missionId, sessionId) }
}

/**
 * A task row: proposals open the inspector, a task with seats opens the seat
 * the desktop would pick from that task's own sessions (the shared
 * {@link taskOpenSeat}, so the mission-wide remembered tab can only win when it
 * is one of them), and a task without a session opens its details.
 */
export function deckTaskOpen(
  issue: IssueNavigationModel,
  seats: DeckSeats,
  crew: readonly SessionView[],
  remembered: string | null,
): DeckOpen {
  if (issue.stage === 'proposed') {
    return { kind: 'push', href: `/inspect/${encodeURIComponent(issue.id)}` }
  }
  const target = taskOpenSeat({
    members: seats.full
      .task(issue.id)
      .sessionIds.map((id) => seats.pool.sessionObject(id) as SessionView),
    remembered,
    taskCoordinatorSessionId: issue.coordinatorSessionId,
    rootCoordinatorSessionId: null,
  })
  if (!target) return { kind: 'push', href: `/issue/${encodeURIComponent(issue.id)}` }
  return crew.some((session) => session.sessionId === target)
    ? { kind: 'chat', sessionId: target }
    : { kind: 'push', href: missionHref(issue.id, target) }
}

function missionHref(missionId: string, sessionId: string): string {
  return `/mission/${encodeURIComponent(missionId)}?sessionId=${encodeURIComponent(sessionId)}`
}
