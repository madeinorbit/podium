import type { FullDeck, FullDeckTask } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import { observer } from '@podium/client-graph/react'
import { GhostBar } from '@/components/GhostPreview'
import { FlightDeckV6Crew, type FlightDeckV6Actions } from './FlightDeckV6Rows'
import type { DeckWindow } from './flight-deck-window'

/** Always outside the task filters and folds. The same arrangement holds as
 * a simple issue gains helpers, children or phases; the root is never a task. */
export const FlightDeckFullCoordinator = observer(function FlightDeckFullCoordinator({
  full,
  ...actions
}: FlightDeckV6Actions & { full: FullDeck }) {
  const ready = settled(() => {
    void full.root.sessionIds
    void full.coordinatorSessionId
    return true
  })
  if (ready !== true) return <div role="status" aria-label="Loading coordinator"><GhostBar /></div>
  if (full.root.sessionIds.length === 0) return null
  return (
    <section
      className="flight-full-coordinator"
      data-testid="flight-full-coordinator"
      aria-label="Mission sessions"
      data-has-coordinator={full.coordinatorSessionId !== null}
    >
      <FlightDeckV6Crew task={full.root} {...actions} />
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
