import { Tooltip } from '@base-ui/react/tooltip'
import { formatClock } from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model'
import { ChevronDown } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { BrailleSpinner } from '@/lib/motion/BrailleSpinner'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { type TurnPosition, turnClass } from './ChatBlockView'
import {
  type ChatBlock,
  type ToolBatchRow,
  toolCallPhrase,
  toolRunElapsedMs,
  toolRunFailures,
  toolSubject,
  toolVerdict,
} from './chat'
import { ToolBlock, toolCallLabel } from './ToolBlock'

/** While a run is live the timer ticks; a settled row's span never changes, so
 *  it only needs an interval slow enough to cost nothing. */
const LIVE_TICK_MS = 1000
const IDLE_TICK_MS = 600_000

/** A settled span shorter than this is noise on the row — the count already says
 *  the run happened. (The span is a lower bound: see toolRunElapsedMs.) */
const MIN_SETTLED_SPAN_MS = 1500

/** Long enough that sweeping the pointer down a feed of work lines never fires
 *  one, short enough that pausing on a row answers immediately. */
const PREVIEW_DELAY_MS = 400

/** A preview is a glance, not the unfolded run — past this the panel would be a
 *  second transcript, so it names the overflow and defers to the fold. */
const MAX_PREVIEW_CALLS = 8

/** How long the settle morph runs. Matches the `work-line-settle` keyframe. */
const SETTLE_MS = 300

/**
 * True for one beat after a live run resolves to done, and never on mount — a
 * transcript of a hundred finished runs must not replay a hundred settles when
 * it paints. The morph belongs to the TRANSITION, which is the only moment a
 * reader could be watching for it.
 */
function useSettleFlash(live: boolean): boolean {
  const [settling, setSettling] = useState(false)
  const wasLive = useRef(live)
  useEffect(() => {
    const resolved = wasLive.current && !live
    wasLive.current = live
    if (!resolved) return undefined
    setSettling(true)
    const timer = setTimeout(() => setSettling(false), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [live])
  return settling
}

/**
 * WHICH FOUR (POD-423). The collapsed line names its subjects — "Read
 * ChatView.tsx, TranscriptFeed.tsx +4" — but seeing which four meant clicking,
 * which unfolds the row and moves everything underneath it. This answers the
 * question without changing anything: the same lines the fold would reveal,
 * minus their results.
 *
 * It rides a base-ui tooltip rather than an absolutely positioned panel of its
 * own, which is where it parts company with the per-message actions it
 * otherwise copies (POD-411). Those fit INSIDE their row's box; this panel is
 * taller than the row it hangs off, and an absolutely positioned box still
 * contributes to its scroll container's scrollable overflow — so a panel under
 * the last work line would grow the feed's scroll height and resize the
 * scrollbar the moment the pointer landed. Portalled out of the scroller it has
 * no layout cost at all, and collision handling flips it above the row near the
 * bottom of the window instead of clipping it.
 *
 * The keyboard route is the same route: the tooltip opens on the row button's
 * focus as well as on hover, and Escape dismisses it.
 */
function WorkLinePreview({ blocks }: { blocks: ChatBlock[] }): JSX.Element {
  return (
    <Tooltip.Portal>
      <Tooltip.Positioner
        className="work-line-preview-pos"
        side="bottom"
        align="start"
        sideOffset={5}
        collisionPadding={12}
      >
        <Tooltip.Popup className="work-line-preview">
          <WorkLinePreviewList blocks={blocks} />
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  )
}

/**
 * The panel's contents, kept out of the tooltip parts so what it SAYS can be
 * read without a pointer — see ToolBatchView.test.tsx.
 *
 * It names each call with `toolSubject`, the same function the collapsed
 * summary is built from, so the panel is that line's own sentence unpacked:
 * "Read ChatView.tsx, TranscriptFeed.tsx +4" opens into ChatView.tsx,
 * TranscriptFeed.tsx and the four the summary elided, named identically. The
 * unfolded row is where full paths and results live — a reader asking WHICH
 * wants the basenames they already half-recognise, not eighty characters of
 * worktree prefix.
 */
export function WorkLinePreviewList({ blocks }: { blocks: ChatBlock[] }): JSX.Element {
  const shown = blocks.slice(0, MAX_PREVIEW_CALLS)
  const hidden = blocks.length - shown.length
  return (
    <>
      {shown.map((b) => {
        const label = toolCallLabel(b.item)
        const subject = toolSubject(b.item)
        const verdict = toolVerdict(b.result ?? b.item.toolResult)
        return (
          <div className="work-line-preview-item" key={b.item.id}>
            <span
              className={cn(
                'work-line-preview-glyph',
                verdict === 'err' && 'work-line-preview-glyph--err',
              )}
              aria-hidden="true"
            >
              {verdict === 'err' ? '✕' : verdict === 'ok' ? '✓' : '·'}
            </span>
            {/* An MCP subject already carries its server ("Gmail · send"), so
                printing the label in front of it would stutter. */}
            {!subject?.startsWith(label) && (
              <span className="work-line-preview-label">{label}</span>
            )}
            {subject && <span className="work-line-preview-subject">{subject}</span>}
          </div>
        )
      })}
      {hidden > 0 && <div className="work-line-preview-more">+{hidden} more — click to unfold</div>}
    </>
  )
}

/**
 * The work line (POD-364): a run of consecutive tool calls rendered as ONE
 * progress object rather than N log entries.
 *
 * While the agent works, the row mutates in place — the braille spinner, the
 * call in flight ("Editing ChatView.tsx"), a counting timer, and a count that
 * ticks per call. Nothing below it moves, because the row's height never
 * changes and the count is mono `tabular-nums`, so digits can't shift width.
 * Once the run settles the spinner becomes a verdict glyph and the phrase
 * becomes the past-tense summary ("Read 2 files, ran a command").
 *
 * Behind the collapsed row, two hairline tiers fan out — carved into the field,
 * not lifted off it — so a folded run reads as a stack without costing the
 * height of one. Click anywhere on the row to unfold the individual calls.
 * Failure is never hidden by the fold: the count of failed calls stays on the
 * collapsed line. One [data-block] row → one minimap tick, so a forty-call turn
 * reads as one beat of activity. Search auto-expands it via `forceOpen`.
 *
 * POD-423 adds the two things the fold still cost a reader. Hovering or focusing
 * a folded run previews the calls it holds without unfolding it, so finding out
 * WHICH four files were read no longer moves the page (see WorkLinePreview);
 * and when a live run resolves, the row plays one settle rather than swapping
 * silently from spinner to verdict (see useSettleFlash).
 */
export function ToolBatchView({
  row,
  index,
  highlighted,
  dimmed,
  forceOpen,
  live = false,
  waiting,
  arrived = false,
  turn,
  sessionId,
  cwd,
  openFile,
}: {
  row: ToolBatchRow
  index: number
  highlighted: boolean
  dimmed: boolean
  forceOpen: boolean
  /** True only for the trailing run of a turn the agent is still working on. */
  live?: boolean
  /** A live tool that is an external dependency: named and still, never a
   *  second spinner beside the transcript tail. */
  waiting?: { label: string; detail?: string | undefined } | undefined
  /** This row landed after the feed was already on screen (POD-423) — it plays
   *  its one-shot arrival. See `useFeedArrivals`. */
  arrived?: boolean
  /** This row's place in its exchange (POD-376) — a run binds to the prose that
   *  produced it, so it is normally 'bind'. See TranscriptFeed. */
  turn?: TurnPosition
  sessionId: SessionId
  cwd: string
  openFile: (sessionId: SessionId, path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const expanded = open || forceOpen
  const rowClass = cn(
    'transcript-row mx-auto w-full max-w-[960px]',
    turnClass(turn),
    arrived && 'transcript-arrive',
    highlighted && 'transcript-search-hit',
    dimmed && 'opacity-35',
  )
  const count = row.blocks.length
  const failed = toolRunFailures(row.blocks)
  // One interval per work line, and only a live one ticks — a settled
  // transcript full of them must not re-render every second.
  const computing = live && !waiting
  const now = useNow(live ? LIVE_TICK_MS : IDLE_TICK_MS)
  const elapsedMs = toolRunElapsedMs(row.blocks, live ? now : undefined)
  const showElapsed =
    elapsedMs !== undefined && (live || (count > 1 && elapsedMs >= MIN_SETTLED_SPAN_MS))
  // A tools row always folds ≥1 block, so the last one exists.
  const lastItem = row.blocks[count - 1]!.item
  const settling = useSettleFlash(computing)
  // A lone call is already named in full on the row — there is no "which four"
  // to answer, so it carries the plain native title instead of a panel.
  const previewable = count > 1
  const face: ReactNode = (
    <>
      <span
        className={cn('work-line-glyph', failed > 0 && !live && 'work-line-glyph--err')}
        aria-hidden="true"
      >
        {computing ? <BrailleSpinner size={11} /> : waiting ? '◇' : failed > 0 ? '✕' : '✓'}
      </span>
      <span className="work-line-phrase">
        {waiting
          ? `${waiting.label}${waiting.detail ? ` · ${waiting.detail}` : ''}`
          : live
            ? toolCallPhrase(lastItem)
            : row.title}
      </span>
      {failed > 0 && <span className="work-line-fail">✕ {failed} failed</span>}
      {showElapsed && <span className="work-line-time">{formatClock(elapsedMs)}</span>}
      <span className="work-line-count">{count}</span>
      <ChevronDown className="work-line-chev" size={11} aria-hidden="true" />
    </>
  )
  const toggle = (): void => setOpen((v) => !v)
  return (
    <div className={rowClass} data-block={index}>
      {/* No rail — tool activity stays quiet, aligned with prose via the spacer. */}
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body py-0.5">
        <div
          className="work-line"
          data-state={waiting ? 'wait' : live ? 'live' : 'done'}
          data-open={expanded ? 'true' : 'false'}
          data-single={count === 1 ? 'true' : undefined}
          data-settle={settling ? 'true' : undefined}
          data-testid="work-line"
        >
          {/* The fanned deck: two same-tone tiers, hidden for a lone call and
              once the run is unfolded. */}
          <div className="work-line-deck" aria-hidden="true">
            <i />
            <i />
          </div>
          {previewable ? (
            <Tooltip.Root disabled={expanded}>
              {/* `disabled` here means "do not open", not the HTML attribute:
                  unfolded, the calls are already on screen and a panel repeating
                  them over the top of them is noise. Disable the tooltip root,
                  not its button, so the same row still refolds on click. */}
              <Tooltip.Trigger
                data-pressable
                type="button"
                className="work-line-row"
                delay={PREVIEW_DELAY_MS}
                onClick={toggle}
                aria-expanded={expanded}
              >
                {face}
              </Tooltip.Trigger>
              <WorkLinePreview blocks={row.blocks} />
            </Tooltip.Root>
          ) : (
            <button
              data-pressable
              type="button"
              className="work-line-row"
              onClick={toggle}
              aria-expanded={expanded}
              title={row.title}
            >
              {face}
            </button>
          )}
          {expanded && (
            <div className="work-line-list">
              {row.blocks.map((b) => (
                <ToolBlock
                  key={b.item.id}
                  block={b}
                  sessionId={sessionId}
                  cwd={cwd}
                  openFile={openFile}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
