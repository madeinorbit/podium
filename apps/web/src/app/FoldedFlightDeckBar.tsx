import type { MissionProgress } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { MissionScreen, missionRootId } from '@podium/client-graph/mission-screen'
import { observer } from '@podium/client-graph/react'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { PanelLeftOpen } from 'lucide-react'
import { type JSX, useCallback, useEffect, useMemo } from 'react'
import { useRuntimeSelector } from './store'
import { useWorklistPool, useWorklistPoolProjection } from './store-worklist-pool'

/**
 * THE CLOSED DECK IS A HANDLE (POD-2075, calm redesign 4a).
 *
 * Folded, the column used to report the whole mission: the ID chip, a vertical
 * tick gauge, the needs-you and crew stacks and an issue-coloured spine. That was
 * a second deck drawn in 44px beside the sidebar row and the task panel, which
 * already say the same things at a size you can read.
 *
 * Closed, it says two things now: where the deck is (the open control) and how
 * far the mission has got (`done/total`, the open gauge's own datum). The
 * full sentence stays on the count's label and tooltip, so a screen reader and
 * a hover still get the reading the gauge used to give. Both controls open the
 * deck.
 */

/** The mission's state as one sentence — the same one the open gauge speaks, so
 *  folding cannot change what the mission is said to have done (POD-1181). */
function reading(progress: MissionProgress): string {
  const { total, done, run, review, stall, block, wait } = progress
  return [
    `${done} of ${total} task${total === 1 ? '' : 's'} done`,
    run > 0 ? `${run} underway` : null,
    review > 0 ? `${review} in review` : null,
    stall > 0 ? `${stall} stalled` : null,
    block > 0 ? `${block} blocked` : null,
    wait > 0 ? `${wait} to go` : null,
  ]
    .filter(Boolean)
    .join(', ')
}

const NO_PROGRESS: MissionProgress = {
  total: 0,
  done: 0,
  run: 0,
  review: 0,
  stall: 0,
  block: 0,
  wait: 0,
}

/** The Flight Deck's compact state. Folded is one opening of the mission: it
 *  gets its own view model, and reads only the progress tally from it. */
export function FoldedFlightDeckBar({ onExpand }: { onExpand: () => void }): JSX.Element {
  const selectedId = useRuntimeSelector((store) => store.selectedIssueId)
  const pool = useWorklistPool()
  const readRoot = useCallback((pool: MobxPool) => missionRootId(pool, selectedId), [selectedId])
  const rootId = useWorklistPoolProjection(readRoot, LOADING)
  return pool && typeof rootId === 'string' ? (
    <FoldedOpening key={rootId} pool={pool} rootId={rootId} onExpand={onExpand} />
  ) : (
    <FoldedBar progress={NO_PROGRESS} onExpand={onExpand} />
  )
}

const FoldedOpening = observer(function FoldedOpening({
  pool,
  rootId,
  onExpand,
}: {
  pool: MobxPool
  rootId: string
  onExpand: () => void
}): JSX.Element {
  const screen = useMemo(() => new MissionScreen(pool, rootId), [pool, rootId])
  useEffect(() => () => screen.close(), [screen])
  return <FoldedBar progress={screen.ready ? screen.progress : NO_PROGRESS} onExpand={onExpand} />
})

function FoldedBar({
  progress,
  onExpand,
}: {
  progress: MissionProgress
  onExpand: () => void
}): JSX.Element {
  const sentence = progress.total > 0 ? reading(progress) : null
  return (
    <aside
      className="folded-superagent"
      data-flight-deck-mode="folded"
      aria-label="Folded Flight Deck"
    >
      <button
        data-pressable
        type="button"
        className="folded-superagent-control"
        aria-label="Open flight deck"
        title="Open flight deck"
        onClick={onExpand}
      >
        <PanelLeftOpen size={15} aria-hidden="true" />
      </button>
      {sentence && (
        <button
          data-pressable
          type="button"
          data-testid="flight-deck-gauge"
          className="folded-superagent-count"
          aria-label={`Open flight deck · ${sentence}`}
          title={sentence}
          onClick={onExpand}
        >
          {progress.done}/{progress.total}
        </button>
      )}
    </aside>
  )
}
