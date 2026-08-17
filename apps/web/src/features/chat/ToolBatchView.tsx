import { formatClock, parseToolEdit, toolEditUnifiedDiff } from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model/browser'
import { ChevronDown } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
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
/** The diff viewer is a whole second reading surface — a rail, a parser, a
 *  fetcher — and it is needed only once someone clicks a file. Loading it with
 *  the chat would put all of that in the bundle every session pays for on open,
 *  to serve a click most readers never make. */
const DiffSheet = lazy(() =>
  import('@/features/git/DiffSheet').then((m) => ({ default: m.DiffSheet })),
)

const LIVE_TICK_MS = 1000
const IDLE_TICK_MS = 600_000

/** How much of a recorded edit goes to the SHEET. The inline row capped at 160
 *  lines because it was 280px wide; the sheet is a reading surface and matches
 *  the cap its own parser already enforces. */
const SHEET_LINE_CAP = 2500

/** A settled span shorter than this is noise on the row — the count already says
 *  the run happened. (The span is a lower bound: see toolRunElapsedMs.) */
const MIN_SETTLED_SPAN_MS = 1500

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

/** One beat of the deck taking a sheet. Shorter than the settle, because a
 *  batch can land six of these in a second and they must not queue. */
const PUSH_MS = 300

/**
 * True for one beat after the batch grows by a call, and never on mount.
 *
 * Calls two through twelve of a run were the one thing on this surface with no
 * motion at all: the row is already on screen, so nothing ARRIVES, and the
 * count changed between two frames with nothing to mark it. The deck is the
 * honest place to put the beat — it is already drawn, it already means "there
 * are more of these folded behind the line", and gaining a sheet is what
 * actually happened.
 *
 * A fast run re-arms rather than queueing: the timer is replaced, so twelve
 * calls in a second are one continuous settle and not twelve stacked 300ms
 * animations fighting for the same three elements.
 */
function usePushFlash(count: number): boolean {
  const [pushing, setPushing] = useState(false)
  const prev = useRef(count)
  useEffect(() => {
    const grew = count > prev.current
    prev.current = count
    if (!grew) return undefined
    setPushing(true)
    const timer = setTimeout(() => setPushing(false), PUSH_MS)
    return () => clearTimeout(timer)
  }, [count])
  return pushing
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
 * POD-423 gave the fold two softeners: a hover panel previewing the calls a
 * folded run holds, and a settle when a live run resolves rather than a silent
 * swap from spinner to verdict. The settle stays (see useSettleFlash). The
 * panel is gone — POD-993 round 7, at the operator's call: unfolding answers
 * "which four" perfectly well and is the gesture a reader reaches for anyway,
 * while the panel had to be positioned, collision-bounded and height-capped
 * against a feed it floated over. Its short-form text moved to the unfolded
 * rows, which is where it was wanted (see ToolBlock).
 */
export function ToolBatchView({
  row,
  index,
  highlighted,
  dimmed,
  forceOpen,
  live = false,
  endsFeed = false,
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
  /** True only for the trailing run of a turn with a call actually in flight. */
  live?: boolean
  /** This run is the last thing in the feed and the transcript tail has stood
   *  down for it (POD-747), so the row takes the tail's rule out to the right
   *  edge — the transcript still has to END somewhere visible. */
  endsFeed?: boolean
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
  /**
   * THE RUN'S OWN FILES, IN THE BIG DIFF SHEET (POD-993 round 3).
   *
   * A file edit used to unfold into a cramped inline diff inside a work line
   * inside a transcript row — a reading surface three boxes deep and one column
   * wide. The git pane already had the right object for this: a full sheet with
   * a real gutter and room for the hunks. This routes the chat at it.
   *
   * The sheet's rail is SCOPED to the files this run CHANGED, so it opens as a
   * view of "what this batch changed" rather than of the whole worktree — which
   * is what makes it belong to the row you clicked.
   *
   * "Changed", and not "touched", is the whole of a bug that shipped in round
   * three. The rail was built from `toolPaths` — every path any call in the run
   * reported, reads included — so a run that edited one file and read two listed
   * three, disagreeing with the "1 edit" on the folded line right behind it. And
   * because a read has no recorded diff, opening one fell through to `git diff`
   * on a path that git could not accept:
   *
   *     fatal: '/home/podium/.claude/projects/…/land-locally-no-push.md' is
   *     outside repository at '/home/podium/podium/.worktrees/issue-1122-…'
   *
   * An agent reads and writes plenty of files that are not in the repo it is
   * working in — its own memory, a log, something under /tmp — and none of them
   * are diffable against that repo's HEAD. So the rail is the recorded EDITS
   * now. Every entry therefore has a diff from the transcript, which means the
   * git fallback is gone from this path entirely and cannot produce that error
   * again for any path, in-repo or out.
   *
   * AND WHAT IT SHOWS IS THE RUN'S OWN DIFF, not a fresh `git diff` of the path.
   * The transcript already recorded the change — the exact text each call
   * matched and the text it wrote — so that is what goes into the sheet. Asking
   * git instead answers a different question ("what does this file hold now"),
   * and answers it with silence for any edit since committed or written over:
   * the first cut of this did exactly that and showed "No textual change" on a
   * row whose whole subject was a change.
   */
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const { editedPaths, diffSources, pathByBlock } = useMemo(() => {
    const seen: string[] = []
    const patches = new Map<string, string[]>()
    const created = new Set<string>()
    const byBlock = new Map<string, string>()
    // An agent names files however its harness does — `./x`, a path relative to
    // the session's cwd, or an absolute one. The sheet reads better on the short
    // form, and the rail's dir/name split is meaningless on a full absolute
    // path, so everything inside the cwd is shown relative to it. A file outside
    // it keeps its absolute name, which is the only honest thing to call it.
    const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
    const normalise = (raw: string): string => {
      const path = raw.replace(/^\.\//, '')
      return path.startsWith(prefix) ? path.slice(prefix.length) : path
    }
    for (const b of row.blocks) {
      // ONLY a recorded edit. `toolPaths` is every path the call reported —
      // reads included, and files outside the repo — and neither belongs in a
      // list of what this run changed. See the note above.
      const edit = parseToolEdit(b.item.toolInputJson)
      if (!edit?.path) continue
      const text = toolEditUnifiedDiff(edit, SHEET_LINE_CAP)
      if (!text) continue
      const path = normalise(edit.path)
      if (!seen.includes(path)) seen.push(path)
      if (edit.mode === 'write') created.add(path)
      byBlock.set(b.item.id, path)
      // Several calls can edit one file in a single run; they stack in the
      // order the agent made them, which is the order they should be read in.
      patches.set(path, [...(patches.get(path) ?? []), text])
    }
    const sources: Record<string, string> = {}
    for (const [path, parts] of patches) sources[path] = parts.join('\n')
    return {
      // The rail's status word is the sheet's, and the sheet's vocabulary is
      // git's index: "modified (staged)" is a claim about the working tree that
      // a transcript cannot make. These entries sit on the unstaged axis, where
      // the word is plainly "modified" — or "added", for a file the run wrote.
      editedPaths: seen.map((path) => ({
        x: ' ',
        y: created.has(path) ? 'A' : 'M',
        path,
        untracked: false,
      })),
      diffSources: sources,
      pathByBlock: byBlock,
    }
  }, [row.blocks, cwd])
  const expanded = open || forceOpen
  const rowClass = cn(
    'transcript-row',
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
  const pushing = usePushFlash(count)
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
      {/* No padding of its own: the work line carries its own margin, which is
          wider than the feed's beat — a run of calls is a solid in the document,
          and it needs air on both sides that plain prose does not. */}
      <div className="transcript-body">
        <div
          className="work-line"
          data-state={waiting ? 'wait' : live ? 'live' : 'done'}
          data-open={expanded ? 'true' : 'false'}
          data-single={count === 1 ? 'true' : undefined}
          data-settle={settling ? 'true' : undefined}
          data-push={pushing ? 'true' : undefined}
          data-ends-feed={endsFeed ? 'true' : undefined}
          data-testid="work-line"
        >
          {/* The fanned deck: two same-tone tiers, hidden for a lone call and
              once the run is unfolded. */}
          <div className="work-line-deck" aria-hidden="true">
            <i />
            <i />
          </div>
          {/* NO HOVER PANEL (POD-993 round 7). A folded run used to preview its
              calls in a tooltip, so that finding out WHICH four files were read
              did not cost a click that moves the page. Retired at the operator's
              call: unfolding is cheap, it is the gesture a reader reaches for
              anyway, and the panel had to be positioned, collision-bounded and
              height-capped against a feed it was drawn over — three problems the
              disclosure it duplicated does not have. What survives is its TEXT:
              the unfolded rows now carry `toolSubject`, the short form the panel
              was built from. See ToolBlock. */}
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
          {expanded && (
            <div className="work-line-list">
              {row.blocks.map((b) => (
                <ToolBlock
                  key={b.item.id}
                  block={b}
                  sessionId={sessionId}
                  cwd={cwd}
                  openFile={openFile}
                  onOpenDiff={setDiffPath}
                  diffPath={pathByBlock.get(b.item.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {diffPath !== null && editedPaths.length > 0 && (
        // No fallback UI: the sheet is a modal over the feed, and a skeleton
        // flashing behind it would be a second thing appearing. The chunk is
        // small and local, so the click either opens it or opens it a frame late.
        <Suspense fallback={null}>
          <DiffSheet
            cwd={cwd}
            entries={editedPaths}
            initialPath={diffPath}
            sources={diffSources}
            onClose={() => setDiffPath(null)}
            onRefresh={() => {}}
            refreshing={false}
          />
        </Suspense>
      )}
    </div>
  )
}
