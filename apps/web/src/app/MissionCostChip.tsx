import { Popover } from '@base-ui/react/popover'
import {
  COST_HEDGE,
  costHarnessLabel,
  formatCostExact,
  formatCostMark,
  formatCostWeightRatio,
  formatCount,
  formatTokens,
  type TaskCostView,
} from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { useState } from 'react'
import { useMissionCost } from '@/features/cost/useMissionCost'
import { MENU_HOVER_CARD, MENU_SECTION_LABEL } from '@/lib/menu-surface'
import { cn } from '@/lib/utils'
import { useStoreSelector } from './store'

/**
 * THE DECK'S ONE PRICE (POD-1862, design POD-1604 §03).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE ONLY FIGURE IN THE COLUMN
 * ---------------------------------------------------------------------------
 *
 * Not one task strip, agent row or proposal row carries a cost, and that is a
 * decision rather than an omission (POD-1604 §01). The spine answers one
 * question — what needs me, and what is moving — and money answers neither; a
 * dollar figure in a strip is a second axis smuggled into a list built for one.
 * It would also have joined the meta cluster's drop ladder at the bottom, which
 * means the number would go missing exactly when the column is narrow, and a
 * figure you cannot rely on seeing is worse than one you never expected. And at
 * the median it says nothing: half of all costed tasks are under $7.03, so
 * thirty strips would carry thirty small-change figures to surface the two that
 * matter.
 *
 * So the price is asked once, at the level where the question is actually asked
 * — the mission you are looking at, in its header.
 *
 * ---------------------------------------------------------------------------
 * IT IS ONE MORE OBJECT IN A ROW THAT ALREADY EXISTS
 * ---------------------------------------------------------------------------
 *
 * POD-1146 made the gauge, the crew chip and the mission's one action a single
 * row of 26px radius-8 objects on one baseline, and wrote that the row WRAPS
 * rather than crushing its contents when space runs out. This chip is one more
 * object in that row and inherits all of it: no new geometry, no new drop rung,
 * and the gauge keeps taking the slack because the chip — like Add agent —
 * simply never shrinks.
 *
 * THE LABEL IS INSIDE THE CHIP. `COST ≈$226` reads as an instrument; a bare
 * `$225.81` floating beside a mission title reads as a bill. That one word is
 * the whole difference, which is why it is not a tooltip.
 *
 * IT TAKES NO ACCENT, NO HUE AND NO MOTION. The accent on this column is
 * reserved for "a session asked you" and the braille spinner is the only motion
 * licensed in it (POD-758). A chip that tinted with spend, or ticked while a
 * session ran, would be competing for the attention the column exists to
 * allocate. It is mono, tabular, neutral-bordered, and still.
 *
 * ---------------------------------------------------------------------------
 * NO FIGURE MEANS NO CHIP — NEVER AN EMPTY SLOT
 * ---------------------------------------------------------------------------
 *
 * A mission with nothing to report renders nothing at all: the header row is
 * the gauge and Add agent, exactly as it is today. The alternative — a chip
 * reading `—` — is a slot held open for a number rather than a fact, and it is
 * the shape this design explicitly declined (POD-1604 §09).
 *
 * That covers four different silences with one behaviour, deliberately:
 *
 *   the read has not answered yet   nothing is known, so nothing is claimed
 *   `no-sessions`                   POD-1608's case: a truthful zero about a
 *                                   task whose work was booked elsewhere. A
 *                                   confident `$0` here is the sharpest way
 *                                   this feature could lie.
 *   `not-recorded`                  the transcripts are gone. Different from
 *                                   zero, and not a number.
 *   `pending`                       on disk, not yet walked. HALF of all tasks
 *                                   are in this state today, because their
 *                                   transcripts predate the seven-day harvest
 *                                   window, and they can stay in it for the
 *                                   life of this surface. It is emphatically
 *                                   NOT a loading state: a spinner here would
 *                                   promise an arrival that a backfill, not a
 *                                   wait, is what actually delivers.
 *
 * The other three surfaces draw an Unfilled slot for `pending`, because they
 * are cost sections with a layout to hold open. This one is a chip in a row of
 * three objects, so its unfilled slot IS the placeholder dash — and the header
 * changing shape once, early in a mission's life, is the cheaper of the two.
 */
export function MissionCostChip({
  issueId,
  onOpenInExplorer,
}: {
  issueId: string
  /** The chip's last line — the door to the full page, never the chip's job. */
  onOpenInExplorer: () => void
}): JSX.Element | null {
  const trpc = useStoreSelector((s) => s.trpc)
  // Once opened, the cohort stays wanted: the `2.3x median` line is the only
  // thing that needs the whole corpus, and re-fetching it on every close would
  // make closing the popover expensive.
  const [everOpened, setEverOpened] = useState(false)
  const [open, setOpen] = useState(false)
  const { view } = useMissionCost(trpc, issueId, everOpened)
  if (view?.state !== 'costed') return null
  const { rollup } = view
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setEverOpened(true)
      }}
    >
      <Popover.Trigger
        data-testid="mission-cost-chip"
        className={cn(
          'shell-type-micro flex h-[26px] flex-none items-center gap-1.5 rounded-lg',
          'border border-border-strong bg-background px-[9px] font-mono tabular-nums',
          'text-text-dim hover:text-text-strong',
        )}
        aria-label={`Mission cost ${formatCostExact(rollup.estCostUsd)} — open the breakdown`}
      >
        <span className="tracking-[.12em] text-label">COST</span>
        <span className="text-text-strong">{formatCostMark(rollup.estCostUsd, view.floor)}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} className="isolate z-50">
          <Popover.Popup
            data-testid="mission-cost-popover"
            className={cn(MENU_HOVER_CARD, 'w-[268px]')}
            // Opened with the pointer, focus stays on the chip: pulling it into
            // the panel paints a focus ring nobody asked for. Opened from the
            // keyboard, the panel takes it, which is the point of that gesture.
            initialFocus={(openType) => (openType === 'keyboard' ? undefined : false)}
          >
            <MissionCostBreakdown view={view} onOpenInExplorer={onOpenInExplorer} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/**
 * THE ANSWER IN PLACE (POD-1604 §03).
 *
 * The popover is the one place on the deck where cents and the full hedge
 * sentence appear — outside it the figure stays rounded and prefixed, because
 * the rounding IS the provenance. Both behaviours the operator asked for live
 * in one control rather than two competing ones: the panel answers the question
 * where it was asked, and its last line is the door to the explorer for anyone
 * who wants the full page. That ordering is the whole point — most of the time
 * "what has this mission cost" is a glance, not a visit, and the cheap answer
 * must not cost a navigation.
 */
function MissionCostBreakdown({
  view,
  onOpenInExplorer,
}: {
  view: TaskCostView
  onOpenInExplorer: () => void
}): JSX.Element {
  const { own, rollup, descendantCount } = view
  const childrenUsd = Math.max(0, rollup.estCostUsd - own.estCostUsd)
  const attribution = view.floor === 'partial' ? costHarnessLabel(view.harnesses) : null
  return (
    <div className="flex flex-col gap-2.5" data-testid="mission-cost-breakdown">
      <div>
        <div className="flex items-baseline gap-1.5">
          <span
            data-testid="mission-cost-total"
            className="font-mono text-[15px] tabular-nums leading-none text-text-strong"
          >
            {formatCostExact(rollup.estCostUsd)}
          </span>
          {/* A running session means the figure is real and still moving. Two
              words carry that tense for the whole panel, so no row has to hedge
              itself and nothing has to animate to say it. */}
          {view.provisional && <span className="text-[10.5px] text-text-faint">so far</span>}
        </div>
        <p className="mt-1 text-[10.5px] leading-snug text-text-dim">{COST_HEDGE}</p>
      </div>

      <div>
        <div className={cn(MENU_SECTION_LABEL, 'px-0')}>Where it went</div>
        <SplitRow label="This task" usd={own.estCostUsd} />
        {/* NO SPLIT BAR WITHOUT CHILDREN. A two-segment bar with one empty
            segment is a question the reader has to answer before they can read
            the number, so a childless task gets the words and no bar at all. */}
        {descendantCount > 0 ? (
          <>
            <div
              className="mt-1.5 mb-1 flex h-1.5 overflow-hidden rounded-sm bg-background"
              data-testid="mission-cost-split"
              aria-hidden="true"
            >
              {/* INK STEPS, NEVER HUE — the deck's rule, and the ledger's. The
                  denser segment is this task's own; the fainter one is the work
                  under it. */}
              <span className="bg-text-dim" style={{ flexGrow: own.estCostUsd }} />
              <span className="bg-text-faint" style={{ flexGrow: childrenUsd }} />
            </div>
            <SplitRow
              label={`${formatCount(descendantCount)} sub-task${descendantCount === 1 ? '' : 's'}`}
              usd={childrenUsd}
            />
          </>
        ) : (
          <div className="mt-0.5 text-[11px] text-text-faint">No sub-tasks</div>
        )}
      </div>

      {rollup.models.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-hairline-soft pt-2">
          {rollup.models.map((model) => (
            <div key={model.model} className="flex items-baseline gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-text-dim">{model.model}</span>
              <span className="font-mono tabular-nums text-text-strong">
                {formatCostExact(model.estCostUsd)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1 border-t border-hairline-soft pt-2">
        <div className="flex items-baseline gap-2 font-mono text-[10.5px] tabular-nums text-text-faint">
          <span>
            {formatCount(rollup.sessionCount)} session{rollup.sessionCount === 1 ? '' : 's'} ·{' '}
            {formatCount(rollup.messages)} replies
          </span>
          <span className="ml-auto">{formatTokens(rollup.totalTokens)} tok</span>
        </div>
        {/* THE MULTIPLE IS LABELLED, and that is why it rides here rather than
            on the chip: on the header there is room for the word `Rate`, which
            is what stops a bare `2.3x` asking "x what?". */}
        {view.rateVsMedian !== null && (
          <div className="flex items-baseline gap-2 text-[11px]">
            <span className="text-text-dim">Rate</span>
            <span className="ml-auto font-mono tabular-nums text-text-strong">
              {formatCostWeightRatio(view.rateVsMedian)} median
            </span>
          </div>
        )}
        {/* The `≥` on the chip is a claim, so the panel says what it rests on.
            An unexplained lower-bound mark is the same "x what?" problem. */}
        {attribution && (
          <div className="flex items-baseline gap-2 text-[11px]">
            <span className="text-text-dim">Attribution</span>
            <span className="ml-auto font-mono text-text-faint">≥ floor · {attribution}</span>
          </div>
        )}
      </div>

      <Popover.Close
        className="-mx-[5px] flex items-center rounded-md px-[5px] py-[4.5px] text-left text-[11.5px] text-text-dim outline-none hover:bg-hairline-soft hover:text-text-strong focus-visible:bg-hairline-soft focus-visible:text-text-strong"
        onClick={onOpenInExplorer}
        data-testid="mission-cost-open"
      >
        Open in explorer
        <span aria-hidden="true" className="ml-1">
          →
        </span>
      </Popover.Close>
    </div>
  )
}

/** One labelled side of the rollup split. Both sides ALWAYS carry their figure:
 *  a bar segment with no number is a proportion, and the question is money. */
function SplitRow({ label, usd }: { label: string; usd: number }): JSX.Element {
  return (
    <div className="mt-0.5 flex items-baseline gap-2 text-[11px]">
      <span className="min-w-0 flex-1 truncate text-text-dim">{label}</span>
      <span className="font-mono tabular-nums text-text-strong">{formatCostExact(usd)}</span>
    </div>
  )
}
