import type { TranscriptActivityRun } from '@podium/client-core/conversation'
import { useActivityDisclosure } from '@podium/client-core/react'
import {
  activityRowSingletonDisplay,
  activitySingletonDisplay,
  formatClock,
  resolveToolEdit,
  type ToolEditView,
  toolBatchTitles,
  toolEditDiffKey,
  toolEditHasDiff,
  toolEditUnifiedDiff,
} from '@podium/client-core/values'
import type { SessionId } from '@podium/model/browser'
import {
  machinePathKey,
  machinePathRelativeToRoot,
  resolveMachinePath,
} from '@podium/model/browser'
import { ChevronRight } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { throughRestarts } from '@/lib/chunk-recovery'
import { useAgeNow } from '@/lib/clock-hooks'
import { cn } from '@/lib/utils'
import { type ProcessPosition, processClass, type TurnPosition, turnClass } from './ChatBlockView'
import {
  type ActivityStretchRow,
  type ChatBlock,
  toolCallPhrase,
  toolRunElapsedMs,
  toolRunFailures,
  toolSubject,
} from './chat'
import { handleChatMdClick } from './chat-md-click'
import { InboxReadRow, SentNoteRow } from './MailCommandRow'
import { MessageEnvelopeGroup } from './MessageEnvelopeGroup'
import { ToolBlock } from './ToolBlock'
import { clockLabel, parseTs } from './transcript-time'
import { WorkGlyph } from './WorkGlyph'

/** While a run is live the timer ticks; a settled row's span never changes, so
 *  it only needs an interval slow enough to cost nothing. */
/** The diff viewer is a whole second reading surface — a rail, a parser, a
 *  fetcher — and it is needed only once someone clicks a file. Loading it with
 *  the chat would put all of that in the bundle every session pays for on open,
 *  to serve a click most readers never make. */
const DiffSheet = lazy(() =>
  throughRestarts(() => import('@/features/git/DiffSheet')).then((m) => ({ default: m.DiffSheet })),
)

const EMPTY_BLOCKS: ChatBlock[] = []

/** How much of a recorded edit goes to the SHEET. The inline row capped at 160
 *  lines because it was 280px wide; the sheet is a reading surface and matches
 *  the cap its own parser already enforces. */
const SHEET_LINE_CAP = 2500

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

/** A stretch of commands and notes owns one feed row and minimap tick.
 * Folded it counts the events; opened it keeps each member's own disclosure.
 * Search expands both layers so a match in a body or result stays visible.
 */
export const ToolBatchView = observer(function ToolBatchView({
  row,
  run,
  index,
  highlighted,
  dimmed,
  forceOpen,
  live = false,
  ownsTail = live,
  endsFeed = false,
  waiting,
  arrived = false,
  turn,
  process,
  sessionId,
  cwd,
  openFile,
}: {
  row: ActivityStretchRow
  run?: TranscriptActivityRun
  index: number
  highlighted: boolean
  dimmed: boolean
  forceOpen: boolean
  /** True only for the trailing run of a turn with a call actually in flight. */
  live?: boolean
  /** Whether this row owns the live phrase, glyph and timer. TranscriptFeed
   *  keeps that status in TranscriptTail and always passes false. */
  ownsTail?: boolean
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
  /** This row's place in the visible process narrative. */
  process?: ProcessPosition
  sessionId: SessionId
  cwd: string
  openFile: (sessionId: SessionId, path: string) => void
}): JSX.Element {
  const { userOpen: open, open: expanded, setOpen, toggle } = useActivityDisclosure({ forceOpen })
  const count = run?.count ?? row.blocks.length
  const first = run?.firstBlock ?? row.blocks[0]!
  const singleton = activityRowSingletonDisplay(row, run)
  const singleMember = singleton?.inline ?? false
  const multiple = count > 1 || (singleton?.multiple ?? false)
  const onMemberOpenChange = useCallback(
    (opened: boolean) => {
      if (singleMember || opened) setOpen(opened)
    },
    [singleMember, setOpen],
  )
  const onBodyClick = useCallback(
    (e: ReactMouseEvent) => {
      handleChatMdClick(e, sessionId, cwd, openFile)
    },
    [sessionId, cwd, openFile],
  )
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
  const blocks =
    expanded || singleMember || diffPath !== null ? (run?.blocks ?? row.blocks) : EMPTY_BLOCKS
  // Edit metadata belongs to the disclosed rows and sheet, so even snapshot
  // rows skip payload parsing while folded. `toolEditHasDiff` only splits
  // lines; it never walks the LCS table for a replacement hunk. A chat
  // mount can hold dozens of near-cap hunks, so building every diff up front
  // costs up to 24k cells per hunk before the reader has opened anything. The
  // rail and the per-row open targets therefore come from this cheap pass, and
  // the sheet's text is built below only once the reader asks for it.
  const { editedPaths, pathByBlock, editRefs } = useMemo(() => {
    const seen: string[] = []
    const names = new Map<string, string>()
    const created = new Set<string>()
    const byBlock = new Map<string, string>()
    const refs: { blockId: string; path: string; edit: ToolEditView }[] = []
    // An agent names files however its harness does — `./x`, a path relative to
    // the session's cwd, or an absolute one. The sheet reads better on the short
    // form, and the rail's dir/name split is meaningless on a full absolute
    // path, so everything inside the cwd is shown relative to it. A file outside
    // it keeps its absolute name, which is the only honest thing to call it.
    const normalise = (raw: string): string =>
      machinePathRelativeToRoot(cwd, raw) ?? resolveMachinePath(cwd, raw)
    for (const b of blocks) {
      if (b.item.role !== 'tool' || b.mail) continue
      // ONLY a recorded edit. `toolPaths` is every path the call reported —
      // reads included, and files outside the repo — and neither belongs in a
      // list of what this run changed. See the note above.
      const edit = resolveToolEdit(b.item)
      if (!edit?.path) continue
      if (!toolEditHasDiff(edit)) continue
      const spelling = normalise(edit.path)
      const key = machinePathKey(resolveMachinePath(cwd, spelling))
      const path = names.get(key) ?? spelling
      names.set(key, path)
      if (!seen.includes(path)) seen.push(path)
      if (edit.mode === 'write') created.add(path)
      byBlock.set(b.item.id, path)
      refs.push({ blockId: b.item.id, path, edit })
    }
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
      pathByBlock: byBlock,
      editRefs: refs,
    }
  }, [blocks, cwd])
  // THE SHEET'S TEXT, BUILT ONCE PER EDIT AND KEPT ACROSS APPENDS. The first
  // open pays the LCS work; an unrelated transcript update afterwards reuses
  // every unchanged call's entry (keyed by diff content, not by array
  // position) and only diffs what actually arrived. Closing the sheet keeps
  // the entries — reopening is a join, not a recompute.
  const diffCache = useRef(new Map<string, { key: string; text: string }>())
  const sheetOpen = diffPath !== null
  const diffSources = useMemo(() => {
    if (!sheetOpen) return {}
    const live = new Set(editRefs.map((ref) => ref.blockId))
    for (const key of [...diffCache.current.keys()]) {
      if (!live.has(key)) diffCache.current.delete(key)
    }
    const patches = new Map<string, string[]>()
    for (const ref of editRefs) {
      const key = toolEditDiffKey(ref.edit, SHEET_LINE_CAP)
      const cached = diffCache.current.get(ref.blockId)
      let text: string
      if (cached && cached.key === key) {
        text = cached.text
      } else {
        text = toolEditUnifiedDiff(ref.edit, SHEET_LINE_CAP)
        diffCache.current.set(ref.blockId, { key, text })
      }
      if (!text) continue
      // Several calls can edit one file in a single run; they stack in the
      // order the agent made them, which is the order they should be read in.
      patches.set(ref.path, [...(patches.get(ref.path) ?? []), text])
    }
    const sources: Record<string, string> = {}
    for (const [path, parts] of patches) sources[path] = parts.join('\n')
    return sources
  }, [sheetOpen, editRefs])
  const rowClass = cn(
    'transcript-row',
    turnClass(turn),
    processClass(process),
    arrived && 'transcript-arrive',
    highlighted && 'transcript-search-hit',
    dimmed && 'opacity-35',
  )
  const failed = run?.failures ?? toolRunFailures(row.blocks)
  // The tail owns live status in a feed. Yield the phrase, glyph and timer
  // together so this stretch cannot show a second clock from its first event.
  const ownsLiveStatus = live && ownsTail
  const activeWaiting = ownsTail ? waiting : undefined
  // A tools row always folds ≥1 block, so the last one exists.
  const lastItem = (run?.lastBlock ?? row.blocks[count - 1]!).item
  const title = run?.title ?? row.title
  const firstItem = first.item
  const singleCommand = count === 1 && firstItem.toolName === 'Bash'
  const summary =
    count > 1
      ? (run?.summary ?? row.summary ?? toolBatchTitles(row.blocks).summary)
      : singleCommand
        ? (toolSubject(firstItem, Infinity) ?? title)
        : title
  const settling = useSettleFlash(ownsLiveStatus)
  const pushing = usePushFlash(count)
  const phrase = activeWaiting
    ? `${activeWaiting.label}${activeWaiting.detail ? ` · ${activeWaiting.detail}` : ''}`
    : ownsLiveStatus
      ? toolCallPhrase(lastItem)
      : summary
  const accessibleSummary =
    `${phrase}. ${count} ${count === 1 ? 'event' : 'events'}` +
    `${failed > 0 ? `. ${failed} failed` : ''}.`
  const face: ReactNode = (
    <>
      <span
        className={cn('work-line-glyph', failed > 0 && !live && 'work-line-glyph--err')}
        aria-hidden="true"
      >
        <WorkGlyph item={firstItem} stretch={multiple} />
      </span>
      <span
        className={cn('work-line-phrase', singleCommand && !ownsLiveStatus && 'work-line-code')}
      >
        {phrase}
      </span>
      {failed > 0 && <span className="work-line-fail">✕ {failed} failed</span>}
      {multiple && (
        <ChevronRight className="work-line-chev" size={12} strokeWidth={1.5} aria-hidden="true" />
      )}
      {(!live || ownsTail) && (
        <ToolElapsed run={run} blocks={row.blocks} live={ownsLiveStatus} count={count} />
      )}
    </>
  )
  return (
    <div
      className={rowClass}
      data-block={index}
      data-row-key={run?.ids[0] ?? row.blocks[0]!.item.id}
      data-transcript-retain={open || diffPath !== null ? '' : undefined}
      data-row-aliases={run ? undefined : JSON.stringify(row.blocks.map((block) => block.item.id))}
    >
      {/* No rail — tool activity stays quiet, aligned with prose via the spacer. */}
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      {/* No padding of its own: the work line carries its own margin, which is
          wider than the feed's beat — a run of calls is a solid in the document,
          and it needs air on both sides that plain prose does not. */}
      <div className="transcript-body">
        <div
          className="work-line"
          data-state={activeWaiting ? 'wait' : ownsLiveStatus ? 'live' : live ? 'pending' : 'done'}
          data-verdict={failed > 0 ? 'err' : undefined}
          data-transcript-run-view={!singleMember || (forceOpen && !open) ? '' : undefined}
          data-open={expanded ? 'true' : 'false'}
          data-single={count === 1 ? 'true' : undefined}
          data-settle={settling ? 'true' : undefined}
          data-push={pushing ? 'true' : undefined}
          data-ends-feed={endsFeed ? 'true' : undefined}
          data-testid="work-line"
        >
          {/* NO HOVER PANEL (POD-993 round 7). A folded run used to preview its
              calls in a tooltip, so that finding out WHICH four files were read
              did not cost a click that moves the page. Retired at the operator's
              call: unfolding is cheap, it is the gesture a reader reaches for
              anyway, and the panel had to be positioned, collision-bounded and
              height-capped against a feed it was drawn over — three problems the
              disclosure it duplicated does not have. What survives is its TEXT:
              the unfolded rows now carry `toolSubject`, the short form the panel
              was built from. See ToolBlock. */}
          {!singleMember && (
            <button
              data-pressable
              type="button"
              className="work-line-row"
              onClick={toggle}
              data-transcript-run-toggle=""
              aria-expanded={expanded}
              aria-label={accessibleSummary}
              title={title}
            >
              {face}
            </button>
          )}
          {(expanded || singleMember) && (
            <div
              className={
                singleMember ? 'work-line-members' : 'work-line-list work-line-list--timed'
              }
            >
              {blocks.map((b) => (
                <StretchMember
                  key={b.item.id}
                  block={b}
                  timed
                  forceOpen={forceOpen}
                  onOpenChange={onMemberOpenChange}
                  onBodyClick={onBodyClick}
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
})

const ToolElapsed = observer(function ToolElapsed({
  run,
  blocks,
  live,
  count,
}: {
  run?: TranscriptActivityRun
  blocks: ChatBlock[]
  live: boolean
  count: number
}) {
  const first = run?.firstBlock ?? blocks[0]
  const now = useAgeNow(first?.item.ts ?? '', 0, live)
  const elapsedMs =
    !live && count === 1
      ? first?.item.durationMs
      : run
        ? run.elapsed(live ? now : undefined)
        : toolRunElapsedMs(blocks, live ? now : undefined)
  const last = run?.lastBlock ?? blocks.at(-1)
  const start = parseTs(first?.item.ts)
  const end = parseTs(last?.item.ts)
  const figure =
    !live && count > 1 && start && end
      ? `${clockLabel(start)}–${clockLabel(end)}`
      : elapsedMs === undefined
        ? undefined
        : formatClock(elapsedMs)
  return figure ? <span className="work-line-time">{figure}</span> : null
})

export function StretchMember({
  block,
  onBodyClick,
  forceOpen,
  ordinary = false,
  initialOpen,
  onOpenChange,
  ...toolProps
}: Parameters<typeof ToolBlock>[0] & {
  onBodyClick: (e: ReactMouseEvent) => void
  forceOpen: boolean
  ordinary?: boolean
}) {
  const display = activitySingletonDisplay(block)
  if (display.kind === 'received-notes')
    return (
      <MessageEnvelopeGroup
        bare
        envelopes={display.batch.envelopes}
        ts={block.item.ts}
        onBodyClick={onBodyClick}
        forceOpen={forceOpen}
        onOpenChange={onOpenChange}
        ordinary={ordinary}
        initialOpen={initialOpen}
      />
    )
  if (display.kind === 'sent-note')
    return (
      <SentNoteRow
        bare
        note={display.mail}
        fallbackId={block.item.id}
        initialOpen={initialOpen}
        ts={block.item.ts}
        onBodyClick={onBodyClick}
        forceOpen={forceOpen}
        onOpenChange={onOpenChange}
      />
    )
  if (display.kind === 'inbox-read')
    return (
      <InboxReadRow
        bare
        notes={display.mail.notes}
        result={block.result ?? block.item.toolResult}
        rowKey={block.item.id}
        initialOpen={initialOpen}
        ts={block.item.ts}
        forceOpen={forceOpen}
        onOpenChange={onOpenChange}
      />
    )
  return (
    <ToolBlock
      block={block}
      forceOpen={forceOpen}
      onOpenChange={onOpenChange}
      initialOpen={initialOpen}
      {...toolProps}
    />
  )
}
