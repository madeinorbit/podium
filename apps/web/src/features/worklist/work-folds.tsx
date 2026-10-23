import { useAgeNow, useClock } from '@/lib/clock-hooks'
import { relativeTime } from '@podium/client-core/focus'
import {
  type IssueNavigationModel,
  issueClosedFoldAt,
} from '@podium/client-core/values'
import { canonicalIssueCloseReason, ISSUE_STATUS_LABELS } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { observer } from '@podium/client-graph/react'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import { Archive } from 'lucide-react'
import * as m from 'motion/react-m'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { PanelVisible, usePanelVisible } from '@/app/panel-visible'
import { useReducedMotion } from '@/lib/use-reduced-motion'
import { NotSavedMark } from '@/components/NotSavedMark'
import { cn } from '@/lib/utils'
import type { RowTone } from './pool-row-data'
import { RowStatusMark, rowToneInk } from './WorkRowShell'
import { EASE_FOLD, EASE_IN, EASE_OUT, MOTION_S } from './worklist-motion-tokens'

/**
 * THE SECTION BAND (POD-1057, the 3a design).
 *
 * It was a label floating on the column's ground — fine while every row under it
 * drew a hairline, but with the rules gone (see `WorkRowShell`) the labels were
 * the only structure left in a 30-row column and the lightest marks in it. So it
 * became a BAND: 34px of ground under a hairline, full-bleed, `--muted`. It had a
 * rule on both edges while it was the only ruled thing in the column; with the
 * rows ruled again (POD-1078) the top one was drawing a second line a pixel
 * under the last row's, so the band keeps the edge that is its own.
 *
 * AND IT IS A CONTROL: every band shuts, taking the group's rows and its
 * snoozed/closed tails, so four repos fold to four lines. State persists per
 * user (`fold-keys.ts`). The chevron is revealed, not resident — but a COLLAPSED
 * band keeps it, since a shut band that looked like an empty open one is a trap.
 */
/** The band's own geometry and ground, without the affordances of a control.
 *  Shared because the empty work list wears a band too (POD-1058) and there is
 *  nothing there to fold: a STATIC band, so it takes the shape and the tone but
 *  none of the hover, focus or transition a button needs. Two spellings of
 *  35px/`--muted`/hairline would drift the moment one of them is retuned.
 *
 *  35px, NOT 34 (POD-1253): the mock's `height:34px` is a CONTENT box — the file
 *  sets `box-sizing:border-box` exactly once, on its outer <section>, so the
 *  1px rule sits OUTSIDE the 34 and the band measures 35. Ours spent the rule
 *  inside the 34 and gave the band 33px of ground. Same reading error as the
 *  row's `min-height`, one pixel instead of four. */
export const SECTION_BAND_CLASS =
  'flex h-[35px] w-full flex-none items-center gap-[9px] border-b border-hairline-bar bg-muted px-[13px] text-left'

/** The band's label voice — mono, tracked, `--muted-foreground` because the band
 *  is a header rather than a floating caption. */
export const SECTION_BAND_LABEL_CLASS =
  'label-mono min-w-0 flex-1 truncate tracking-[.16em] text-muted-foreground'

/**
 * THE DISCLOSURE, ANIMATED (POD-1253).
 *
 * Every fold in this column — the section bands, the snoozed tail, the closed
 * tail — used to be `{!collapsed && rows}`: thirty rows present in one frame and
 * absent in the next, with everything below them teleporting into the hole. The
 * band's chevron was the only part of the gesture that moved, which made the
 * turn read as a hiccup rather than as a fold.
 *
 * WHAT MOVES IS THE CLIP, NOT THE CONTENT. The panel animates its own height
 * from 0 to the content's natural height while clipping; the rows inside never
 * move, never squash and never re-lay-out. So the eye follows one edge sweeping
 * up the column, the rows below ride it exactly (they are `layout="position"`
 * elements whose `layoutDependency` does NOT bump on a fold — see
 * `SidebarUnified` — so Motion never measures and never animates a second,
 * competing interpolation against this one), and the text stays legible the
 * whole way down.
 *
 * `contain: layout paint` is not decoration: animating height relayouts every
 * frame, and without containment a webview is free to keep a stale tile of a
 * row mid-collapse (POD-1146, the Flight Deck's own height one-shot). It makes
 * the panel its own containing block and clips its subtree to it, so a shrinking
 * fold can never paint past its bounds however the frame lands.
 *
 * THE OPACITY IS NOT THE HEIGHT'S TWIN. A fade running the full length of the
 * collapse leaves half-transparent rows sliding under the band, which reads as
 * two things happening. Out is quick and front-loaded (the rows are gone before
 * the edge arrives); in is short and late (the space is made, then the rows
 * appear in it) — the shape a disclosure has when it feels like one surface
 * sliding over another rather than a list dissolving.
 */
/**
 * THE CURVE AND THE TIMING come from `worklist-motion-tokens` (POD-2080): the
 * standard decelerate arc, 200ms open and 160ms shut. The first cut ran 320ms
 * and 260ms on `[0.4, 0, 0.2, 1]`, which the operator found too slow; the
 * strong expo-out the shell uses for chips is still wrong over this distance
 * (POD-1253 measured it spending 76% of the travel in the first 18% of the
 * time, a snap followed by a drift).
 */
const FOLD_IN = {
  height: { duration: MOTION_S.foldOpen, ease: EASE_FOLD },
  opacity: { duration: MOTION_S.foldOpen - 0.06, delay: 0.04, ease: EASE_OUT },
}
/** A folder header's drag folds its rows away and back within ≈120ms, so the
 *  header is what moves and the gesture never waits on the fold (POD-2074). */
const FOLD_QUICK = {
  height: { duration: MOTION_S.foldQuick, ease: EASE_FOLD },
  opacity: { duration: 0.08, ease: EASE_OUT },
}
const FOLD_OUT = {
  height: { duration: MOTION_S.foldClose, ease: EASE_FOLD },
  opacity: { duration: 0.08, ease: EASE_IN },
}

/**
 * NO `AnimatePresence` (POD-1253). The obvious spelling of this is
 * `<AnimatePresence>{open && <m.div exit=… />}</AnimatePresence>`, and it
 * cost 27KB of eager source — enough to push the web bundle through its ratchet
 * (7,613,223 against a 7,600,000 ceiling), for one component's exit. The
 * repository's own precedent is to pay the eager bundle down rather than raise
 * the ratchet, so the presence machinery is replaced by the two lines it is
 * doing here: keep the subtree mounted while it plays its exit, drop it when the
 * exit lands. The shared lazy Motion boundary already supplies `m.div`.
 */
export function FoldPanel({
  open,
  id,
  testId,
  dragScope,
  retain = false,
  quick = false,
  children,
}: {
  open: boolean
  id?: string
  testId?: string
  /** Optional manual-sort scope. When present, draggable rows must be direct
   *  children of this panel; useRowDrag relies on that boundary to exclude the
   *  nested snoozed/closed folds from the live-row order. */
  dragScope?: string
  /** Keep a visited project group's DOM, with hidden readers and clocks paused. */
  retain?: boolean
  /** Use the drag's quick fold in both directions. */
  quick?: boolean
  children: ReactNode
}): JSX.Element | null {
  const reduceMotion = useReducedMotion()
  const parentVisible = usePanelVisible()
  // Derived during render, not in an effect: an effect would mount the rows one
  // frame after the press, and that frame is visible at the head of a gesture
  // whose whole job is to feel immediate.
  const [rendered, setRendered] = useState(open)
  const visited = useRef(open)
  if (open) visited.current = true
  if (open && !rendered) setRendered(true)
  // The first paint of a column is not a disclosure: an open fold on load must
  // simply BE open, or every reload plays thirty rows unrolling. Only a fold
  // that has actually been toggled animates in, which is what this ref tracks —
  // it survives the inner element unmounting, because it lives out here.
  const settled = useRef(false)
  const firstPaint = !settled.current
  settled.current = true
  if (!rendered && (!retain || !visited.current)) return null
  return (
    <m.div
      id={id}
      data-testid={testId}
      data-work-fold-panel
      data-drag-scope={dragScope}
      aria-hidden={!open}
      inert={!open}
      className="min-w-0 overflow-hidden"
      style={{ contain: 'layout paint', ...(!rendered ? { display: 'none' } : {}) }}
      initial={firstPaint ? false : { height: 0, opacity: 0 }}
      animate={
        open
          ? { height: 'auto', opacity: 1, transition: reduceMotion ? { duration: 0 } : quick ? FOLD_QUICK : FOLD_IN }
          : { height: 0, opacity: 0, transition: reduceMotion ? { duration: 0 } : quick ? FOLD_QUICK : FOLD_OUT }
      }
      onAnimationComplete={() => {
        // Only the CLOSING one retires the subtree; the opening animation
        // completes too, and unmounting there would shut the fold it just opened.
        if (!open) setRendered(false)
      }}
    >
      <PanelVisible visible={parentVisible && open}>{children}</PanelVisible>
    </m.div>
  )
}

/** How a folded row ended, in one dim mono word (POD-293). Merged is the common
 *  closed outcome; snooze shows the time left. Nothing here is an ask, so none
 *  of it is amber. */
export function foldedMarker(
  issue: IssueNavigationModel,
  lane: 'closed' | 'snoozed',
  now: number,
): string {
  if (lane === 'snoozed') {
    const until = issue.deferUntil ? Date.parse(issue.deferUntil) : NaN
    if (!Number.isFinite(until)) return 'snoozed'
    const mins = Math.max(0, Math.round((until - now) / 60000))
    if (mins < 60) return 'snoozed <1h'
    const hours = Math.round(mins / 60)
    if (hours < 24) return `snoozed ${hours}h`
    return `snoozed ${Math.round(hours / 24)}d`
  }
  if (issue.gitState?.merged) return 'merged'
  // One word, lowercased from the shared status vocabulary (POD-1074) — so a
  // row folded as `wontfix` in the store reads "cancelled" here, the same word
  // the status menu offers, instead of the third spelling ("won't fix") this
  // switch used to keep to itself.
  const reason = canonicalIssueCloseReason(issue.closedReason)
  if (reason && reason !== 'done') return ISSUE_STATUS_LABELS[reason].toLowerCase()
  return 'closed'
}

/** How a folded row ended, as the calm row's status voice (POD-2074): Done
 *  with a check, a stop with a minus, a snooze with its time left. */
export function foldedVoice(
  issue: IssueNavigationModel,
  lane: 'closed' | 'snoozed',
): { tone: RowTone; word: string } {
  if (lane === 'snoozed') return { tone: 'idle', word: 'Snoozed' }
  const reason = canonicalIssueCloseReason(issue.closedReason)
  if (!reason || reason === 'done') return { tone: 'done', word: 'Done' }
  return { tone: 'closed', word: reason === 'cancelled' ? 'Closed' : ISSUE_STATUS_LABELS[reason] }
}

/** A folded (closed / snoozed) issue in the Snoozed and Closed lanes: the live
 *  row's two lines, with none of its live vocabulary — no fleet, git or unread.
 *  Clicking selects the issue; a closed row's archive rides over its age. */
function FoldedWorkRowInner({
  model,
  issue: suppliedIssue,
  lane,
  active,
  onSelect,
  onContextMenu,
  onArchive,
}: {
  model?: WorklistIssue
  issue?: IssueNavigationModel
  lane: 'closed' | 'snoozed'
  now?: number
  active: boolean
  onSelect: () => void
  onContextMenu?: (e: ReactMouseEvent) => void
  /** Archive this closed row (remove it from the sidebar). */
  onArchive?: () => void
}): JSX.Element {
  const issue = model ? (model.issue as unknown as IssueNavigationModel) : suppliedIssue!
  // Closed rows date from the fold (the tuck, else the finish) — the same
  // stamp grouping uses; snoozed rows from their last activity (POD-293).
  const stampIso = lane === 'closed' ? (model?.foldAt ?? issueClosedFoldAt(issue)) : issue.updatedAt
  const voice = foldedVoice(issue, lane)
  return (
    <div className="group/closed relative min-w-0 px-2 py-px" data-testid={lane === 'closed' ? 'closed-fold-row' : 'snoozed-fold-row'}>
      <button
        data-pressable
        type="button"
        data-testid="folded-work-row"
        data-lane={lane}
        data-selected={active ? 'true' : 'false'}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        title={`${issueDisplayRef(issue)} · ${issue.title}`}
        className={cn(
          'shell-work-row flex w-full min-w-0 flex-col gap-1 text-left leading-[normal]',
          !active && 'hover:bg-[var(--work-row-hover)]',
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span
            className={cn(
              'shell-work-row-title min-w-0 flex-1 truncate',
              active ? 'font-semibold text-text-strong' : lane === 'closed' ? 'text-text-dim' : 'text-foreground',
            )}
          >
            {issue.title}
          </span>
          <NotSavedMark kind="issue" id={issue.id} />
          <span
            className={cn(
              'work-row-meta flex-none font-mono tabular-nums text-text-faint',
              onArchive && 'group-hover/closed:invisible group-focus-within/closed:invisible',
            )}
          >
            {stampIso && <FoldAge stamp={stampIso} />}
          </span>
        </span>
        <span className="shell-work-row-status flex w-full min-w-0 items-center gap-[7px]" data-tone={voice.tone}>
          <RowStatusMark tone={voice.tone} />
          <span className="flex min-w-0 flex-1 items-center gap-[5px] overflow-hidden whitespace-nowrap">
            <span style={{ color: rowToneInk(voice.tone) }}>{voice.word}</span>
            <FoldMarker issue={issue} lane={lane} />
          </span>
          <span className="work-row-ref flex-none font-mono tabular-nums text-text-faint">
            <span className="sr-only">{issueDisplayRef(issue)}</span>
            <span aria-hidden="true">#{issue.seq}</span>
          </span>
        </span>
      </button>
      {onArchive && (
        <button
          data-pressable
          type="button"
          data-hover-reveal
          className="absolute top-[7px] right-[18px] z-20 flex size-5 items-center justify-center rounded-[5px] text-text-dim opacity-0 transition-[color,opacity,background-color] group-hover/closed:opacity-100 group-focus-within/closed:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong"
          aria-label={`Archive ${issueDisplayRef(issue)}`}
          title="Archive — remove from sidebar"
          data-testid="closed-issue-archive"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onArchive()
          }}
        >
          <Archive size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export const FoldedWorkRow = FoldedWorkRowInner
export const WorklistFoldedRow = observer(FoldedWorkRowInner)

/** The sub-fact after the folded word: `· merged`, `· 3h left`. */
const FoldMarker = observer(function FoldMarker({ issue, lane }: { issue: IssueNavigationModel; lane: 'closed' | 'snoozed' }) {
  const marker = foldedMarker(issue, lane, useClock(60_000, lane === 'snoozed'))
  const sub =
    lane === 'snoozed'
      ? marker === 'snoozed' ? null : `${marker.replace('snoozed ', '')} left`
      : marker === 'merged' ? 'merged' : null
  return sub ? <span className="text-text-faint">· {sub}</span> : null
})
function FoldAge({ stamp }: { stamp: string }) {
  return <span>{relativeTime(stamp, useAgeNow(stamp)).replace(/ ago$/, '').replace('just now', 'now')}</span>
}
