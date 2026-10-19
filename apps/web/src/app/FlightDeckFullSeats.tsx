import { LOADING } from '@podium/client-graph/loading'
import type { FullDeck, FullDeckTask } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import { observer } from '@podium/client-graph/react'
import { GhostBar } from '@/components/GhostPreview'
import {
  type FlightDeckV6Actions,
  FlightDeckV6Crew,
  FlightDeckV6Session,
  FlightDeckV6SessionSlot,
} from './FlightDeckV6Rows'
import type { DeckWindow } from './flight-deck-window'

/** The mission's coordinator alone, always outside the task filters and folds.
 * The same arrangement holds as a simple issue gains helpers, children or
 * phases; the root is never a task. */
export const FlightDeckFullCoordinator = observer(function FlightDeckFullCoordinator({
  full,
  ...actions
}: FlightDeckV6Actions & { full: FullDeck }) {
  const ready = settled(() => {
    if (!full.root.row.drawable) return false
    void full.coordinatorSessionId
    return true
  })
  if (ready !== true)
    return (
      <div role="status" aria-label="Loading coordinator">
        <GhostBar />
      </div>
    )
  const id = full.coordinatorSessionId
  if (id === null) return null
  return (
    <section
      className="flight-full-coordinator"
      data-testid="flight-full-coordinator"
      aria-label="Mission coordinator"
    >
      <FlightDeckV6SessionSlot task={full.root} id={id} {...actions} />
    </section>
  )
})

/** The mission's other agents open the task list, right after the done line.
 * Like the coordinator they belong to no task, so filters, search and folds
 * never hide them. */
export const FlightDeckFullHelpers = observer(function FlightDeckFullHelpers({
  full,
  ...actions
}: FlightDeckV6Actions & { full: FullDeck }) {
  const ids = settled(() => full.root.helperIds)
  if (ids === LOADING || ids.length === 0) return null
  return (
    <section
      className="flight-full-helpers"
      data-testid="flight-full-helpers"
      aria-label="Mission helpers"
    >
      <div className="flight-v6-sessions">
        {ids.map((id) => (
          <FlightDeckV6SessionSlot key={id} task={full.root} id={id} {...actions} />
        ))}
      </div>
    </section>
  )
})

/** The model orders the marked phase lead first and identifies every other
 * session as a helper. The shared session row supplies all conversation actions. */
export const FlightDeckFullPhaseCrew = observer(function FlightDeckFullPhaseCrew({
  task,
  window,
  ...actions
}: FlightDeckV6Actions & { task: FullDeckTask; window: DeckWindow }) {
  return <FlightDeckV6Crew task={task} window={window} {...actions} />
})

/** Archived conversations participate in the same single selection as live
 * seats, while their existing disclosure and conversation routing stay intact. */
export const FlightDeckFullArchivedSession = observer(function FlightDeckFullArchivedSession({
  full,
  id,
  activeSessionId,
  onOpen,
}: {
  full: FullDeck
  id: string
  activeSessionId: string | null
  onOpen: (permanent: boolean) => void
}) {
  const session = full.screen.reader.rawSession(id)
  if (session === LOADING)
    return (
      <div role="status" aria-label="Loading session">
        <GhostBar />
      </div>
    )
  return session ? (
    <FlightDeckV6Session
      task={full.task(session.issueId ?? full.rootId)}
      session={session}
      active={activeSessionId === id}
      onOpen={onOpen}
    />
  ) : null
})
