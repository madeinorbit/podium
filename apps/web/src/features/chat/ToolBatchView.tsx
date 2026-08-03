import { formatClock } from '@podium/client-core/viewmodels'
import { ChevronDown } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { BrailleSpinner } from '@/lib/motion/BrailleSpinner'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { type ToolBatchRow, toolCallPhrase, toolRunElapsedMs, toolRunFailures } from './chat'
import { ToolBlock } from './ToolBlock'

/** While a run is live the timer ticks; a settled row's span never changes, so
 *  it only needs an interval slow enough to cost nothing. */
const LIVE_TICK_MS = 1000
const IDLE_TICK_MS = 600_000

/** A settled span shorter than this is noise on the row — the count already says
 *  the run happened. (The span is a lower bound: see toolRunElapsedMs.) */
const MIN_SETTLED_SPAN_MS = 1500

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
 */
export function ToolBatchView({
  row,
  index,
  highlighted,
  dimmed,
  forceOpen,
  live = false,
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
  sessionId: string
  cwd: string
  openFile: (sessionId: string, path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const expanded = open || forceOpen
  const rowClass = cn(
    'transcript-row mx-auto w-full max-w-[960px]',
    highlighted && 'rounded-md outline outline-1 outline-primary outline-offset-4',
    dimmed && 'opacity-35',
  )
  const count = row.blocks.length
  const failed = toolRunFailures(row.blocks)
  // One interval per work line, and only a live one ticks — a settled
  // transcript full of them must not re-render every second.
  const now = useNow(live ? LIVE_TICK_MS : IDLE_TICK_MS)
  const elapsedMs = toolRunElapsedMs(row.blocks, live ? now : undefined)
  const showElapsed =
    elapsedMs !== undefined && (live || (count > 1 && elapsedMs >= MIN_SETTLED_SPAN_MS))
  // A tools row always folds ≥1 block, so the last one exists.
  const lastItem = row.blocks[count - 1]!.item
  return (
    <div className={rowClass} data-block={index}>
      {/* No rail — tool activity stays quiet, aligned with prose via the spacer. */}
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body py-0.5">
        <div
          className="work-line"
          data-state={live ? 'live' : 'done'}
          data-open={expanded ? 'true' : 'false'}
          data-single={count === 1 ? 'true' : undefined}
          data-testid="work-line"
        >
          {/* The fanned deck: two same-tone tiers, hidden for a lone call and
              once the run is unfolded. */}
          <div className="work-line-deck" aria-hidden="true">
            <i />
            <i />
          </div>
          <button
            data-pressable
            type="button"
            className="work-line-row"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={expanded}
            title={row.title}
          >
            <span
              className={cn('work-line-glyph', failed > 0 && !live && 'work-line-glyph--err')}
              aria-hidden="true"
            >
              {live ? <BrailleSpinner size={11} /> : failed > 0 ? '✕' : '✓'}
            </span>
            <span className="work-line-phrase">{live ? toolCallPhrase(lastItem) : row.title}</span>
            {failed > 0 && <span className="work-line-fail">✕ {failed} failed</span>}
            {showElapsed && <span className="work-line-time">{formatClock(elapsedMs)}</span>}
            <span className="work-line-count">{count}</span>
            <ChevronDown className="work-line-chev" size={11} aria-hidden="true" />
          </button>
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
