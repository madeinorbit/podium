/**
 * THE WORK LIST WITH NOTHING IN IT (POD-1058, "ADE Empty States" 2a/2b).
 *
 * Four ghost rows under a section band, and nothing else. What it replaced was
 * a single grey sentence ("Nothing yet — start an agent or create an issue
 * above"), which told the operator the list was empty — a fact they could
 * already see — and nothing about what a filled one looks like.
 *
 * NO CAPTION EITHER. The ghosts carried a line under them ("One row per task,
 * newest first") until POD-1225. A drawing of the list does not need a sentence
 * explaining that it is a list; the shape already says it, and the caption only
 * held the reader on a surface whose whole job is to be left.
 *
 * NO SPAWN OF ITS OWN. The surface carried a "New Claude" button repeating the
 * spawn row directly above it and the ⌘N chord; a third delivery of one action,
 * inside the only view where the other two are already unmissable. Starting
 * work stays with the row that owns it.
 *
 * IT MIRRORS THE 3a ROW, NOT THE ONE BEFORE IT. The ghost's whole claim is
 * "this is what will be here", so its anatomy is read from the live row's own
 * constants rather than copied by eye: `ID_GUTTER_W` for the number gutter,
 * `META_COL_W` for the fixed right-hand meta column, `shell-work-row` for the
 * padding, the rule and the density switch, the 13px inset, the 11px/5px gaps.
 * When the row is retuned again, those move with it and the ghost follows for
 * free — which is the only way this stays true.
 *
 * THE BAND NAMES NOTHING, BECAUSE THERE IS NOTHING TO NAME (POD-1469). It used
 * to read `WORK IN PODIUM` — the repo the spawn row above it was pointed at —
 * because an empty column left the operator wondering which project they were
 * looking at. Every project in the fleet now draws its own band, so by the time
 * this surface renders there is no project to name: it is the no-repos state,
 * and `Add repository` sits on the line above it. It is a STATIC band — there is
 * nothing under it to fold, so it takes the shape and the ground but not the
 * chevron.
 *
 * THE COUNT STAYS HONEST. `0` is rendered here, where a live band hides it. The
 * ghosts are the one thing on this surface that could be mistaken for data, and
 * a live zero beside them is the cheapest possible proof that they are not.
 */
import type { JSX } from 'react'
import { GhostBar, GhostPreview } from '@/components/GhostPreview'
import { cn } from '@/lib/utils'
import { ID_GUTTER_W, META_COL_W } from './WorkRowShell'
import { SECTION_BAND_CLASS, SECTION_BAND_LABEL_CLASS } from './work-folds'

/**
 * One dead row, at the live row's own geometry.
 *
 * It wears `shell-work-row` itself, so the padding, the density switch and the
 * row rule (POD-1078) are the live row's by construction and cannot drift from
 * it: when the first task lands the ghosts fade out and the real row fades in ON
 * THE SAME SLOT rather than shunting the copy below it. No meter line: the meter
 * is optional per row and taking it would put the four ghosts on two different
 * heights, which is a worse lie than omitting it.
 *
 * Widths vary per row and the tiers step down — the design's "bars, never
 * lorem" and "never a uniform block", which are the two things that separate a
 * hint from a rendering fault.
 */
function GhostWorkRow({
  tier,
  title,
  status,
  meta,
  selected,
}: {
  tier: 1 | 2 | 3 | 4
  title: string
  status: string
  /** Width of the line-1 meta bar, inside the fixed meta column. */
  meta?: number
  selected?: boolean
}): JSX.Element {
  const next = Math.min(tier + 1, 4) as 1 | 2 | 3 | 4
  return (
    <div
      className={cn(
        'shell-work-row flex min-h-[46px] min-w-0 items-center px-[13px]',
        selected && 'bg-chip',
      )}
      // The selected row's spine, in ghost ink rather than `--text-strong`: the
      // anatomy is worth showing, but a full-strength spine would assert that
      // one of four dead rows is the one you are in.
      style={selected ? { boxShadow: 'inset 3px 0 0 var(--ghost-1)' } : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center gap-[11px]">
        {/* The identity gutter: right-aligned, because the live one right-aligns
            its digits so three- and four-digit refs share an edge. */}
        <span className="flex flex-none justify-end" style={{ width: ID_GUTTER_W }}>
          <GhostBar tier={tier} width="18px" height={8} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className="flex min-w-0 items-center gap-2">
            <GhostBar tier={tier} width={title} height={8} className="min-w-0" />
            <span className="flex-1" />
            {/* Reserved at the live column's width whether or not it holds
                anything — the same rule the real row follows, and the reason
                every ghost title ellipsizes at one x. */}
            <span className="flex flex-none justify-end" style={{ minWidth: META_COL_W }}>
              {meta !== undefined && <GhostBar tier={next} width={`${meta}px`} height={7} />}
            </span>
          </span>
          {/* Line 2 — the mono status lockup, always a step fainter than the
              title above it. */}
          <GhostBar tier={next} width={status} height={7} />
        </span>
      </div>
    </div>
  )
}

export function WorkListEmpty(): JSX.Element {
  // NO PROJECT NAME LEFT TO SHOW (POD-1469). This surface used to read the
  // spawn row's default target to write `WORK IN PODIUM` — but a project in the
  // fleet now draws its OWN band with `Start first task` under it, so the only
  // state that still reaches here is the one with no project at all. `WORK` is
  // then the honest heading, and the door out is `Add repository` on the line
  // directly above.
  return (
    <>
      <div className={SECTION_BAND_CLASS} data-testid="work-empty-band">
        <span className={SECTION_BAND_LABEL_CLASS}>Work</span>
        <span className="shell-type-micro flex-none font-mono tabular-nums text-muted-foreground">
          0
        </span>
      </div>

      {/* Straight under the band, where the real rows start. Four is enough to
          show the anatomy and the banding without the block becoming the
          surface's subject. */}
      <GhostPreview className="flex flex-none flex-col" testId="work-ghost-rows">
        <GhostWorkRow tier={1} title="58%" status="44%" meta={30} selected />
        <GhostWorkRow tier={2} title="72%" status="36%" meta={22} />
        <GhostWorkRow tier={3} title="46%" status="52%" />
        <GhostWorkRow tier={4} title="64%" status="30%" />
      </GhostPreview>
    </>
  )
}
