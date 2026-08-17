import { shallowEqual } from '@podium/client-core/store'
import {
  buildFlightDeckRows,
  type MissionProgress,
  missionCrewLabel,
  missionProgress,
  selectedMissionRoot,
} from '@podium/client-core/viewmodels'
import type { IssueColorSlot } from '@podium/model/browser'
import { ChevronRight, MessageCircleQuestion, Users } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useMemo } from 'react'
import { IdSquare, idSquareLabel } from '@/components/IdSquare'
import { BrailleSpinner } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { useReplicaIssues, useStoreSelector } from './store'

/**
 * THE CLOSED DECK REPORTS INSTEAD OF LABELLING (POD-738).
 *
 * Folded, this column used to spend its 44px on two chips and the words FLIGHT
 * DECK set vertically — a label naming the column you just closed, which is the
 * one thing the operator who closed it already knows. Everything the mission
 * was actually DOING went with the fold, so the closed state was a different
 * object rather than the same one narrowed.
 *
 * It is an instrument now:
 *
 *   THE SPINE. The line that marks the selected row in the work list keeps
 *   running down this rail's left edge as a 2px gradient — full strength beside
 *   the ID chip, gone by the end of the gauge (`.folded-superagent`,
 *   styles.css). That is what makes the closed rail read as BELONGING to the
 *   mission without a hard colour edge, and it is why the right-hand border is
 *   gone: columns here are separated by tone (POD-725), so the one line the
 *   rail draws should be the one that means something.
 *
 *   THE CHIP. The mission's own ID square at 32px — the identity mark the work
 *   list, the right rail and the mobile header already use, so the rail names
 *   WHICH mission instead of which column.
 *
 *   THE GAUGE. One tick per task, top-down, in the open gauge's own state order
 *   (done → in review → underway → blocked → to go) so review-stage work
 *   never reads as active execution when the deck folds. The column itself
 *   becomes the meter; the exact datum sits under it.
 *
 *   THE FOOT. What wants you, at the bottom where the thumb rests — amber ONLY
 *   when something is actually asking — and then fleet presence. A stack with
 *   nothing in it is not drawn at all, the same rule the open gauge's bands
 *   follow, so the rail can only say things the mission is really doing.
 */

/** Top-down state order, identical to the open gauge's bands. */
const TICK_ORDER = ['done', 'review', 'run', 'block', 'wait'] as const

/**
 * Where one-tick-per-task stops being a reading and becomes a texture.
 *
 * Under this the column draws a tick per task and every tick is a task you can
 * point at. Over it the ticks would be thinner than the gaps between them, so
 * the column keeps the SAME four states and sizes them by share instead: the
 * resolution drops, the reading does not, and the datum underneath is
 * unchanged either way. That is DESIGN.md §5's shed ladder — data before
 * material, and nothing is ever clipped.
 */
const TICK_LIMIT = 40

/** The column's height once it draws shares rather than tasks — about what five
 *  full ticks occupy, and shrinkable from there on a short rail. */
const SHARE_HEIGHT = 154

/** The gap closes as the mission grows, so a long mission's ticks stay ticks
 *  instead of becoming a dotted line of mostly gap. */
function tickGap(total: number): number {
  if (total <= 12) return 5
  return total <= 24 ? 3 : 2
}

/**
 * The picker is unreachable from this rail (`primaryOnly` — every click here
 * opens the deck), and the chip may be an ANCESTOR root rather than the
 * selected issue, so wiring the shell's selected-issue handler in would
 * recolour the wrong task the day it did become reachable.
 */
const NO_COLOUR_PICK = (_color: IssueColorSlot | null): void => {}

/** The mission's state as one sentence — the same one the open gauge speaks, so
 *  folding cannot change what the mission is said to have done. It said `running`
 *  here against the gauge's `in progress` for the same bucket, which is exactly
 *  the drift that claim exists to forbid; both say `underway` now (POD-1181). */
function reading(progress: MissionProgress): string {
  const { total, done, run, review, block, wait } = progress
  return [
    `${done} of ${total} task${total === 1 ? '' : 's'} done`,
    run > 0 ? `${run} underway` : null,
    review > 0 ? `${review} in review` : null,
    block > 0 ? `${block} blocked` : null,
    wait > 0 ? `${wait} to go` : null,
  ]
    .filter(Boolean)
    .join(', ')
}

/** The rail as the mission's progress meter. */
function SpineGauge({
  progress,
  onExpand,
}: {
  progress: MissionProgress
  onExpand: () => void
}): JSX.Element {
  const { total, done, run, review, block, wait } = progress
  const counts = { done, run, review, block, wait }
  const perTask = total <= TICK_LIMIT
  const marks = perTask
    ? TICK_ORDER.flatMap((state) =>
        Array.from({ length: counts[state] }, (_, index) => ({
          key: `${state}:${index}`,
          state,
          share: 0,
        })),
      )
    : TICK_ORDER.filter((state) => counts[state] > 0).map((state) => ({
        key: state,
        state,
        share: counts[state],
      }))
  const sentence = reading(progress)
  return (
    <button
      data-pressable
      type="button"
      data-testid="flight-deck-gauge"
      data-resolution={perTask ? 'task' : 'share'}
      className="flex min-h-0 w-full shrink grow-0 flex-col items-center gap-3 pt-3.5"
      aria-label={`Expand Flight Deck · ${sentence}`}
      title={sentence}
      onClick={onExpand}
    >
      {/* The ticks SHRINK before they overflow: a tall rail draws them at their
          full 26px, a short one squeezes them, and neither ever clips a task
          out of the column. */}
      <span
        className="flex min-h-0 shrink grow-0 flex-col items-center"
        style={{ gap: perTask ? tickGap(total) : 2, flexBasis: perTask ? 'auto' : SHARE_HEIGHT }}
      >
        {marks.map((mark) => (
          <span
            key={mark.key}
            className="deck-tick"
            data-s={mark.state}
            data-testid="deck-tick"
            style={perTask ? undefined : { flexGrow: mark.share, flexBasis: 0 }}
          />
        ))}
      </span>
      <span className="shell-type-micro flex-none font-mono tabular-nums text-text-dim">
        {done}/{total}
      </span>
    </button>
  )
}

/** One foot stack: the glyph in its cell and its count under it, both inside
 *  the control — a numeral sitting under a live target must not be a dead one. */
function FootStat({
  testId,
  label,
  title,
  count,
  attention = false,
  onExpand,
  children,
}: {
  testId: string
  label: string
  title: string
  /** Null draws the cell with no numeral: a count of nothing is not a zero. */
  count: number | null
  attention?: boolean
  onExpand: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      data-testid={testId}
      className="folded-superagent-stat"
      aria-label={label}
      title={title}
      onClick={onExpand}
    >
      <span className="folded-superagent-cell" data-attention={attention ? 'true' : undefined}>
        {children}
      </span>
      {count !== null && (
        <span
          className={cn(
            'shell-type-micro font-mono tabular-nums',
            attention ? 'font-bold text-attention' : 'text-text-faint',
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

/** The Flight Deck's compact state keeps its operational payload visible. */
export function FoldedFlightDeckBar({ onExpand }: { onExpand: () => void }): JSX.Element {
  const { sessions, selectedIssueId } = useStoreSelector(
    (store) => ({ sessions: store.sessions, selectedIssueId: store.selectedIssueId }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  // This bar is mounted for as long as the deck is folded, so the mission walk
  // is memoized here exactly as the open column memoizes it.
  // Folded and open read the SAME selection rule (POD-1112): a bar that names a
  // mission the open column shows as empty is the two halves of one control
  // disagreeing about what is on screen.
  const root = useMemo(
    () => selectedMissionRoot(issues, sessions, selectedIssueId),
    [issues, sessions, selectedIssueId],
  )
  const rows = useMemo(
    () => (root ? buildFlightDeckRows(issues, sessions, root.id) : []),
    [issues, sessions, root],
  )
  const progress = useMemo(
    () => missionProgress(issues, sessions, root?.id),
    [issues, sessions, root],
  )
  const live = rows[0]?.liveAgentCount ?? 0
  const working = rows[0]?.workingAgentCount ?? 0
  const crew = missionCrewLabel(live, working)
  const needs = rows[0]?.actionableCount ?? 0
  const label = root ? idSquareLabel(root) : null
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
        aria-label="Expand Flight Deck"
        title="Expand Flight Deck"
        onClick={onExpand}
      >
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      {root && label && (
        <IdSquare
          issue={root}
          size={32}
          // The chip is the mission's IDENTITY, not a status light: what the
          // mission is doing is the gauge under it and the foot below that.
          // `selected` is what lets an uncoloured mission still take the flow
          // accent, exactly as the selected work row's square does.
          state={needs > 0 ? 'waiting' : working > 0 ? 'working' : 'idle'}
          selected
          badge={null}
          ringColor="var(--card)"
          titleHint={`${label.full} · ${root.title} — expand Flight Deck`}
          primaryOnly
          onPrimary={onExpand}
          onColorChange={NO_COLOUR_PICK}
        />
      )}
      {progress.total > 0 && <SpineGauge progress={progress} onExpand={onExpand} />}
      <span className="flex-1" aria-hidden="true" />
      <div className="flex flex-none flex-col items-center gap-2.5">
        {/* Obligation first, because it is the one thing here that is asking —
            and it is not drawn at all when nothing is. The rail may not spend
            the shell's one signal colour on a zero. */}
        {needs > 0 && (
          <>
            <FootStat
              testId="flight-deck-attention"
              label={`Expand Flight Deck · ${needs} need you`}
              title={`${needs} need you`}
              count={needs}
              attention
              onExpand={onExpand}
            >
              <MessageCircleQuestion size={16} aria-hidden="true" />
            </FootStat>
            <span aria-hidden="true" className="h-px w-4 flex-none bg-hairline-bar" />
          </>
        )}
        <FootStat
          testId="flight-deck-activity"
          label={`Expand Flight Deck · ${crew}`}
          title={crew}
          count={working > 0 ? working : live > 0 ? live : null}
          onExpand={onExpand}
        >
          {/* The spinner replaces the static fleet glyph only while an agent is
              genuinely computing; the count is who is working then, otherwise
              who is present. */}
          {working > 0 ? <BrailleSpinner size={13} /> : <Users size={16} aria-hidden="true" />}
        </FootStat>
      </div>
    </aside>
  )
}
