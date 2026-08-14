/**
 * THE WORK LIST WITH NOTHING IN IT (POD-1058, "ADE Empty States" 2a/2b).
 *
 * Four ghost rows under a section band, then one line of live copy and the
 * column's own spawn. What it replaced was a single grey sentence ("Nothing yet
 * — start an agent or create an issue above"), which told the operator the list
 * was empty — a fact they could already see — and nothing about what a filled
 * one looks like.
 *
 * IT MIRRORS THE 3a ROW, NOT THE ONE BEFORE IT. The ghost's whole claim is
 * "this is what will be here", so its anatomy is read from the live row's own
 * constants rather than copied by eye: `ID_GUTTER_W` for the number gutter,
 * `META_COL_W` for the fixed right-hand meta column, `shell-work-row` for the
 * padding, the rule and the density switch, the 13px inset, the 11px/5px gaps.
 * When the row is retuned again, those move with it and the ghost follows for
 * free — which is the only way this stays true.
 *
 * THE BAND NAMES THE PROJECT. `WORK IN PODIUM`, not `WORK`: on an empty list
 * the band is the only thing on screen saying WHICH project is empty, and it
 * kills the "is this still loading, or am I pointed at the wrong repo?" doubt
 * that a bare heading leaves open. The string is the repo name the spawn row
 * directly above it already shows, so the two cannot disagree; with no repo
 * resolved it falls back to plain `WORK`. It is a STATIC band — there is
 * nothing under it to fold, so it takes the shape and the ground but not the
 * chevron.
 *
 * THE COUNT STAYS HONEST. `0` is rendered here, where a live band hides it. The
 * ghosts are the one thing on this surface that could be mistaken for data, and
 * a live zero beside them is the cheapest possible proof that they are not.
 */
import { panelLabel } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { GhostBar, GhostPreview } from '@/components/GhostPreview'
import { agentBrandText } from '@/lib/agent-tone'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { cn } from '@/lib/utils'
import { useDefaultSpawn } from './spawn-row'
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
  // `bindChord: false` — the spawn row above this one owns ⌘N. Two mounted
  // owners spawn two agents from one press.
  const { defaultAgent, defaultRepo, defaultTarget, spawn } = useDefaultSpawn(undefined, {
    bindChord: false,
  })
  const project = defaultTarget?.repoName
  return (
    <>
      <div className={SECTION_BAND_CLASS} data-testid="work-empty-band">
        <span className={SECTION_BAND_LABEL_CLASS}>{project ? `Work in ${project}` : 'Work'}</span>
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

      {/* Left-aligned to the list's own text column, not centred: this column is
          read as a list, and a centred block in it reads as a different kind of
          surface. */}
      <div className="flex min-h-0 flex-1 flex-col px-[13px] pt-4 pb-14">
        <p className="text-[14.5px] leading-[1.3] font-semibold tracking-[-.01em] text-text-strong">
          Your work lands here
        </p>
        <p className="mt-[7px] text-[12.5px] leading-[1.5] text-text-dim text-pretty">
          One row per task, newest first.
        </p>
        {defaultRepo && (
          <button
            data-pressable
            type="button"
            data-testid="work-empty-spawn"
            // The SAME spawn as the row above and the ⌘N chord — one action with
            // three deliveries, not a second way to start work that would then
            // need its own explanation of how it differs.
            onClick={() => spawn(defaultAgent, defaultRepo)}
            title={
              defaultTarget
                ? `Start a new ${panelLabel(defaultAgent)} agent in ${defaultTarget.repoName}`
                : undefined
            }
            className="mt-4 flex h-8 items-center justify-center gap-2 rounded-[9px] bg-attention/12 text-[12.5px] font-semibold text-attention ring-1 ring-attention/30 ring-inset hover:bg-attention/20"
          >
            <span
              aria-hidden="true"
              className={cn(
                'size-[10px] flex-none rounded-[3px] bg-current',
                agentBrandText(defaultAgent),
              )}
            />
            New {panelLabel(defaultAgent)}
            {/* The chord is claimed by a native shell only — a browser tab
                keeps ⌘N for its own new window, so promising it there would be
                teaching a shortcut that does nothing. */}
            {nativeDesktopBridge() && (
              <span className="font-mono text-[10px] text-attention/60">⌘N</span>
            )}
          </button>
        )}
      </div>
    </>
  )
}
