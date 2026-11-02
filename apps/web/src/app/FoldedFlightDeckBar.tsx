import {
  type MissionProgress,
  missionProgressLabel,
} from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { MissionScreen, missionRootId } from '@podium/client-graph/mission-screen'
import { observer } from '@podium/client-graph/react'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { PanelLeftOpen } from 'lucide-react'
import {
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
} from 'react'
import { FLIGHT_DECK_ANCHOR } from '@/features/worklist/first-send-tip'
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
 *
 * The bar opens the way a folded column is expected to (POD-2169): a double
 * click anywhere on it, or dragging its right edge out. The drag reports the
 * width the pointer asks for; the shell owns the column and decides on release
 * whether that is far enough to open.
 */

/** The mission's state as one sentence — the same one the open gauge speaks, so
 *  folding cannot change what the mission is said to have done (POD-1181). */

const NO_PROGRESS: MissionProgress = {
  total: 0,
  done: 0,
  working: 0,
  waiting: 0,
  todo: 0,
}

type FoldedBarActions = {
  onExpand: () => void
  /** The width the right-edge drag is asking for, on every pointer move. */
  onDragWidth?: (width: number) => void
  /** The width the drag ended at. */
  onDragEnd?: (width: number) => void
}

/** The Flight Deck's compact state. Folded is one opening of the mission: it
 *  gets its own view model, and reads only the progress tally from it. */
export function FoldedFlightDeckBar(actions: FoldedBarActions): JSX.Element {
  const selectedId = useRuntimeSelector((store) => store.selectedIssueId)
  const pool = useWorklistPool()
  const readRoot = useCallback((pool: MobxPool) => missionRootId(pool, selectedId), [selectedId])
  const rootId = useWorklistPoolProjection(readRoot, LOADING)
  return pool && typeof rootId === 'string' ? (
    <FoldedOpening key={rootId} pool={pool} rootId={rootId} actions={actions} />
  ) : (
    <FoldedBar progress={NO_PROGRESS} actions={actions} />
  )
}

const FoldedOpening = observer(function FoldedOpening({
  pool,
  rootId,
  actions,
}: {
  pool: MobxPool
  rootId: string
  actions: FoldedBarActions
}): JSX.Element {
  const screen = useMemo(() => new MissionScreen(pool, rootId), [pool, rootId])
  useEffect(() => () => screen.close(), [screen])
  return (
    <FoldedBar
      progress={
        screen.ready && screen.full.ready
          ? screen.full.buckets
          : NO_PROGRESS
      }
      actions={actions}
    />
  )
})

function FoldedBar({
  progress,
  actions: { onExpand, onDragWidth, onDragEnd },
}: {
  progress: MissionProgress
  actions: FoldedBarActions
}): JSX.Element {
  const sentence = progress.total > 0 ? missionProgressLabel(progress) : null
  const onEdgePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const handle = e.currentTarget
    // The bar's left edge stays put; the pointer's distance from it is the width.
    const anchorLeft = handle.parentElement?.getBoundingClientRect().left ?? 0
    let width = handle.parentElement?.getBoundingClientRect().width ?? 0
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      width = Math.round(ev.clientX - anchorLeft)
      onDragWidth?.(width)
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      onDragEnd?.(width)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up, { once: true })
    handle.addEventListener('pointercancel', up, { once: true })
  }
  const onEdgeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'End') return
    e.preventDefault()
    onExpand()
  }
  return (
    <aside
      className="folded-superagent"
      data-flight-deck-mode="folded"
      aria-label="Folded Flight Deck"
      data-tip-anchor={FLIGHT_DECK_ANCHOR}
      onDoubleClick={onExpand}
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
      {onDragEnd && (
        // biome-ignore lint/a11y/useSemanticElements: the drag handle is an interactive, keyboard-operable separator
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Drag to open flight deck"
          aria-valuenow={44}
          tabIndex={0}
          data-testid="folded-flight-deck-edge"
          className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60"
          onPointerDown={onEdgePointerDown}
          onKeyDown={onEdgeKeyDown}
        />
      )}
    </aside>
  )
}
