import type { SessionView } from '@podium/client-core/session-values'
import { type IssueNavigationModel, taskOpenSeat } from '@podium/client-core/values'
import type { SessionId } from '@podium/model'

/** Where a task tap on the flight deck page goes. */
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
 * A task row: proposals open the inspector, a task with seats opens the seat
 * the desktop would pick from that task's own sessions (the shared
 * {@link taskOpenSeat}, so the mission-wide remembered tab can only win when it
 * is one of them), and a task without a session opens its details. The deck
 * lists only this mission's tasks, so a picked seat is always on its chat page.
 */
export function deckTaskOpen(
  issue: IssueNavigationModel,
  seats: DeckSeats,
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
  return target
    ? { kind: 'chat', sessionId: target }
    : { kind: 'push', href: `/issue/${encodeURIComponent(issue.id)}` }
}
