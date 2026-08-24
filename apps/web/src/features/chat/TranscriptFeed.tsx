import type {
  ChatActivity,
  ChatBlock,
  ChatRow,
  RenderableRow,
  TranscriptAttributionTable,
  TranscriptPhase,
  TranscriptSearchState,
} from '@podium/client-core/viewmodels'
import {
  attributionForRole,
  isInteractiveTool,
  sessionWaking,
} from '@podium/client-core/viewmodels'
import { agentErrorRecoveryInstruction, formatAgentError } from '@podium/model/browser'
import type { SessionId, SessionMeta } from '@podium/model/browser'
import { ArrowUp, Image as ImageIcon, RotateCcw } from 'lucide-react'
import type { JSX, RefObject } from 'react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { type IssueReferenceLookup, renderMarkdown, sanitizeRenderedMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import { ChatBlockView, type TurnPosition } from './ChatBlockView'
import type { DeadLetteredChatMessage, PendingItem, QueuedChatMessage } from './chat'
import { MetaGlyph } from './MetaGlyph'
import { ToolBatchView } from './ToolBatchView'
import { TranscriptCold } from './TranscriptCold'
import { TranscriptStandby } from './TranscriptStandby'
import { TranscriptTail, trailingRunIsLive, transcriptTailState } from './TranscriptTail'
import { transcriptComputeClient } from './transcript-compute-client'
import { dayKey, dayLabel, rowTimestamp } from './transcript-time'
import { rowIdentity, useFeedArrivals } from './use-feed-arrivals'
import type { HeadlessOverlay } from './use-headless-turn'

const EMPTY_ISSUE_REFERENCES: IssueReferenceLookup = new Map()

/** Render a live partial through the same worker boundary as settled messages. */
function StreamingMarkdown({
  text,
  issueReferences,
}: {
  text: string
  issueReferences: IssueReferenceLookup
}): JSX.Element {
  const client = transcriptComputeClient()
  const [computed, setComputed] = useState<{ text: string; unsafeHtml: string } | null>(null)

  useEffect(() => {
    if (!client.usesWorker) return
    let cancelled = false
    // Provider deltas can arrive token by token. Wait for a short quiet edge so
    // superseded partials do not fill the shared worker queue ahead of settled
    // transcript indexing and search requests.
    const timer = window.setTimeout(() => {
      void client.computeMarkdown(text).then(
        (unsafeHtml) => {
          if (!cancelled) setComputed({ text, unsafeHtml })
        },
        () => {
          if (!cancelled) setComputed({ text, unsafeHtml: client.computeMarkdownOnMain(text) })
        },
      )
    }, 80)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [client, text])

  if (!client.usesWorker) {
    return (
      <div
        className="chat-md chat-md--streaming opacity-80"
        data-testid="streaming-text"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown sanitizes its result
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
    )
  }

  const unsafeHtml = computed?.text === text ? computed.unsafeHtml : undefined
  if (unsafeHtml === undefined) {
    return (
      <div
        className="chat-md chat-md--streaming whitespace-pre-wrap opacity-80"
        data-testid="streaming-text"
      >
        {text}
      </div>
    )
  }
  return (
    <div
      className="chat-md chat-md--streaming opacity-80"
      data-testid="streaming-text"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized below on the browser thread
      dangerouslySetInnerHTML={{ __html: sanitizeRenderedMarkdown(unsafeHtml) }}
    />
  )
}

/**
 * TURN STRUCTURE (POD-376). Thirty-one blocks used to render as thirty-one
 * siblings at one uniform gap: a one-line aside and a four-minute thirteen-call
 * run were spaced identically, and an exchange had no start and no end.
 *
 * The rule is proximity, not decoration — no boxes, no separators, no new
 * chrome. Every row falls into one of three relationships with the row above:
 *
 *   open   the operator's prompt. It BEGINS an exchange, so the air goes here —
 *          in front of it, between exchanges, where a reader's eye is looking
 *          for the seam.
 *   bind   machine activity: a work line, a stray tool row, the "Churned for"
 *          divider. It is the consequence of the prose that introduced it and
 *          sits right under it, close enough to read as one unit.
 *   (beat) everything else — prose, the answer, a question addressed to the
 *          reader. Keeps the feed's original rhythm.
 *
 * Because activity rows are most of a long turn, the feed also gets SHORTER:
 * the space comes back out of the middle of exchanges and is spent on their
 * edges, which is the trade the teardown asked for.
 */
/**
 * WHERE THE DATE CHANGES (POD-701) — mount position → the label to draw above
 * that row. Position-keyed rather than row-keyed because the mounted window is
 * the trailing slice of a much longer list and a row's identity says nothing
 * about which of its neighbours are on screen.
 *
 * The leading mark (`pos 0`) is emitted only when the window does not open on
 * today: "Today" above a transcript entirely from today is a line that tells
 * the reader nothing, while "Tue 5 Aug" above one from last week is the whole
 * point. Rows with no parseable timestamp are transparent — they neither draw a
 * mark nor reset the running day, so an older transcript that predates the
 * field degrades to no marks at all rather than to a mark on every row.
 */
export function dayMarksByPosition(rows: readonly RenderableRow[], now: Date): Map<number, string> {
  const marks = new Map<number, string>()
  let running: string | undefined
  for (const [pos, { row }] of rows.entries()) {
    const at = rowTimestamp(row)
    if (!at) continue
    const key = dayKey(at)
    if (running === undefined) {
      if (key !== dayKey(now)) marks.set(pos, dayLabel(at, now))
    } else if (key !== running) {
      marks.set(pos, dayLabel(at, now))
    }
    running = key
  }
  return marks
}

export function turnPosition(row: ChatRow): TurnPosition | undefined {
  if (row.kind === 'tools') return 'bind'
  const { item } = row.block
  // A call that addresses the human is not machine activity, whatever its role
  // — it stops the turn and waits, so it keeps its own air.
  if (item.role === 'tool') return isInteractiveTool(item) ? undefined : 'bind'
  if (item.role === 'system' && item.systemKind === 'duration') return 'bind'
  return undefined
}

export function queueIsBlocked(session: SessionMeta | undefined): boolean {
  return session?.agentState?.phase === 'errored' && session.agentState.error?.retryable === false
}
export function queuedDeliveryLabel(session: SessionMeta | undefined): string {
  const error = queueIsBlocked(session) ? session?.agentState?.error : undefined
  if (error) {
    const instruction = agentErrorRecoveryInstruction(error).replace(/\.$/, '')
    return `blocked · ${formatAgentError(error)} — ${instruction} to send`
  }
  return sessionWaking(session)
    ? 'pending · sends once the agent is up'
    : 'pending · sends after this turn'
}

/**
 * THE FEED (POD-405) — the scrollable transcript body and everything that rides
 * below it: the optimistic bubbles, the restored queued rows, the headless
 * streaming overlay and the working indicator.
 *
 * Every decision it renders arrives already made. `phase` says whether to show
 * the loader, the empty copy or rows; `rows` is the derived render window
 * including the sticky continuation, with ABSOLUTE indices; `search` says which
 * row is highlighted and which are dimmed. The component's own job is the DOM
 * and the scroll container — the two things a slice cannot own.
 *
 * WHY `phase` HAS NO 'gone' BRANCH HERE. An evicted session (POD-1077) never
 * reaches this component: the shell leaves the view instead, with no tombstone,
 * no toast and no removal animation, because an eviction is a visibility change
 * and not a deletion. Rendering "this was deleted" for it is the exact defect
 * doc §3.1 names; rendering a spinner forever is the other one.
 */
/** How long a row takes to open. Matches the `transcript-unroll` keyframe, and
 *  is the length of the scroll claim the unroll takes out. */
const UNROLL_MS = 260

/**
 * KEEP ONE LIVE MARK THROUGH THE FIRST TOOL ROW'S ARRIVAL (POD-1334).
 *
 * An unresolved trailing run normally owns the tail immediately. When that run
 * is a newly appended row, however, its whole box is still opening from zero
 * height for UNROLL_MS. Removing the generic tail in the same render leaves no
 * visible working mark until enough of the row has been revealed.
 *
 * Hold ownership in the generic tail for that one-shot window. ToolBatchView
 * can already render the arriving call without claiming the live mark; at the
 * end of the window one state update swaps the mark and timer to the run. The
 * arrival latch survives transcript polls, so remember the row whose opening
 * has completed rather than restarting the hold on every render. Reduced
 * motion opens the row immediately and therefore needs no bridge.
 */
function useTrailingRunTailOwnership(
  runIsLive: boolean,
  lastRow: ChatRow | undefined,
  arriving: ReadonlySet<string>,
): boolean {
  const arrivingRunId =
    lastRow?.kind === 'tools' && arriving.has(rowIdentity(lastRow)) ? rowIdentity(lastRow) : null
  const [openedRunId, setOpenedRunId] = useState<string | null>(null)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const opening =
    runIsLive && !reducedMotion && arrivingRunId !== null && openedRunId !== arrivingRunId

  useEffect(() => {
    if (arrivingRunId === null || reducedMotion || openedRunId === arrivingRunId) return undefined
    const timer = window.setTimeout(() => setOpenedRunId(arrivingRunId), UNROLL_MS)
    return () => window.clearTimeout(timer)
  }, [arrivingRunId, openedRunId, reducedMotion])

  return runIsLive && !opening
}

/**
 * THE TURN OPENS (POD-1158). Give every row that ARRIVED — not every row that
 * mounted; `useFeedArrivals` already draws that line — its measured height, and
 * let CSS run it from zero.
 *
 * The measurement is why this lives here rather than in ChatBlockView. There is
 * one `offsetHeight` read per arriving row, bounded by `MAX_ARRIVALS` at four,
 * and doing it centrally means every row renderer gets the same treatment
 * without any of them growing a ref for it. It is a LAYOUT effect because the
 * row must never paint at full height first: the attribute has to be on the
 * element before the browser draws the frame it was inserted on.
 *
 * `data-unroll-seen` latches per ELEMENT, on top of the per-key latch the
 * arrival set already does. The arrival marker deliberately stays on a row for
 * as long as it is mounted (removing it a frame later would cancel the
 * animation mid-flight), so without this a re-render for any of the feed's many
 * other reasons would restart the unroll on a row that finished opening
 * minutes ago.
 */
function useArrivalUnroll(
  scrollerRef: RefObject<HTMLDivElement | null>,
  arriving: ReadonlySet<string>,
  claimScrollForArrival: (ms: number) => void,
): void {
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || arriving.size === 0) return
    // Reduced motion gets the row, in place, at full height, with no attribute
    // set and therefore nothing to clean up.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const fresh = scroller.querySelectorAll<HTMLElement>(
      '.transcript-arrive:not([data-unroll-seen])',
    )
    if (fresh.length === 0) return
    for (const row of fresh) {
      row.dataset.unrollSeen = ''
      const height = row.offsetHeight
      // A ROW WE CANNOT MEASURE IS A ROW WE MUST NOT CLIP (found in WebKit
      // against the running app, POD-1158). `offsetHeight` is zero for a row
      // inside a `display: none` subtree — which this feed genuinely produces,
      // since the panel deck keeps inactive panes mounted and hidden. Stamping
      // one anyway is the worst outcome available: it would animate to
      // `--arrive-h: 0px`, and an animation on a hidden element never runs and
      // so never fires `animationend`, leaving the row clipped to nothing with
      // no way back. The reader switches to that pane and the message is
      // simply not there. A row with nothing to measure has nothing to open.
      if (height === 0) continue
      row.style.setProperty('--arrive-h', `${height}px`)
      row.dataset.unroll = ''
      const release = (): void => {
        row.removeEventListener('animationend', done)
        window.clearTimeout(timer)
        delete row.dataset.unroll
        row.style.removeProperty('--arrive-h')
      }
      function done(event: AnimationEvent): void {
        // A row holds other one-shots — a work line's deck settling, a mail
        // group unfolding — and their `animationend` bubbles to it. Only this
        // row's own unroll may end the unroll.
        if (event.target !== row || event.animationName !== 'transcript-unroll') return
        release()
      }
      // THE CLIP IS NEVER PERMANENT. `animationend` is the normal path and is
      // not a guarantee: an animation that is cancelled, or that never starts
      // because the element stopped being rendered mid-flight, fires nothing.
      // The clip has to come off on a clock as well, because the cost of
      // missing it once is an invisible message that stays invisible.
      const timer = window.setTimeout(release, UNROLL_MS * 3)
      row.addEventListener('animationend', done)
    }
    // One claim covers the whole batch: they start on the same frame and run
    // for the same duration, so N arriving rows are still one rAF loop.
    claimScrollForArrival(UNROLL_MS)
  }, [scrollerRef, arriving, claimScrollForArrival])
}

export function TranscriptFeed({
  scrollerRef,
  onScroll,
  claimScrollForArrival,
  compact,
  superagent,
  phase,
  rows,
  blocks,
  markdownHtml,
  search,
  moreAbove,
  loadingOlder,
  loadOlder,
  sessionId,
  cwd,
  session,
  httpOrigin,
  openFile,
  onOpenImage,
  onAnswerAsk,
  livePendingAskIndex,
  pendingAskBlock,
  lastAnswerBlockIndex,
  ctxSeq,
  collapseContext,
  stickyEnabled,
  isOperatorPromptRow,
  pending,
  restoredQueued,
  restoredFailed = [],
  onRetractQueued,
  onRetryFailed,
  overlay,
  activity,
  attribution,
  scrollerEpoch = 0,
  expandRuns = false,
  onQuote,
  issueReferences = EMPTY_ISSUE_REFERENCES,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  /** Hand the scroll to the arriving row's own rAF pin while it unrolls, so the
   *  observers stand down instead of writing the bottom on every frame. */
  claimScrollForArrival: (ms: number) => void
  compact: boolean
  /** This feed fronts a SUPERAGENT thread rather than an agent's session — it
   *  changes what an empty transcript means, and nothing else. */
  superagent: boolean
  phase: TranscriptPhase
  rows: readonly RenderableRow[]
  blocks: readonly ChatBlock[]
  /** Unsafe HTML produced by the shared worker; ChatBlockView sanitizes it. */
  markdownHtml: ReadonlyMap<string, string>
  search: TranscriptSearchState
  moreAbove: boolean
  loadingOlder: boolean
  loadOlder: () => void
  sessionId: SessionId
  cwd: string
  session: SessionMeta | undefined
  httpOrigin: string
  openFile: (sessionId: SessionId, path: string) => void
  onOpenImage: (url: string) => void
  onAnswerAsk: (answer: import('./AskUserQuestionCard').AskUserQuestionAnswer) => Promise<void>
  livePendingAskIndex: number
  /** A live question the transcript does not carry yet, drawn from agent state.
   *  Rendered at the end of the feed, where the transcript item will appear. */
  pendingAskBlock: ChatBlock | null
  lastAnswerBlockIndex: number
  ctxSeq: number | null
  collapseContext: boolean
  stickyEnabled: boolean
  isOperatorPromptRow: (row: RenderableRow['row']) => boolean
  pending: readonly PendingItem[]
  restoredQueued: readonly QueuedChatMessage[]
  restoredFailed?: readonly DeadLetteredChatMessage[]
  onRetractQueued: (id: string) => Promise<void>
  onRetryFailed?: (text: string) => void
  overlay: HeadlessOverlay | null
  activity: ChatActivity | null
  /** The session's three attribution pairs (doc §3.1.3 A3), derived once by the
   *  slice. Each row picks its pair by role; the objects are stable, so the
   *  memoized block views keep skipping renders. */
  attribution: TranscriptAttributionTable
  /** Bumps when the scroll hook proves the Safari 26.4 wedge (round 6): a
   *  changed epoch keys the scroller, React replaces the DOM node, and the
   *  engine builds a fresh scrolling node — the only repair the wedge
   *  respects (a pixel-identical clone scrolled to the bottom the wedged
   *  element could not reach; nothing done to the element itself did). */
  scrollerEpoch?: number
  /** Verbose mode (POD-376): every run renders already unfolded. Verbose changes
   *  how a run LOOKS, not which rows exist, so it rides down here rather than
   *  through the row derivation. */
  expandRuns?: boolean
  /** Quote a message into the composer (POD-376 per-message actions). Absent →
   *  the Quote action is not offered, which is what a host without a composer
   *  should get rather than a button that does nothing. */
  onQuote?: (markdown: string) => void
  issueReferences?: IssueReferenceLookup
}): JSX.Element {
  // Which rows LANDED, as opposed to which rows merely rendered — see
  // use-feed-arrivals. Identity is per row and index-free, so paging older
  // messages in above does not read as the whole feed arriving at once.
  const arriving = useFeedArrivals(useMemo(() => rows.map(({ row }) => rowIdentity(row)), [rows]))
  useArrivalUnroll(scrollerRef, arriving, claimScrollForArrival)
  const searchMatches = useMemo(() => new Set(search.matches), [search.matches])
  // Recomputed with the rows rather than on a clock: "Today" only goes stale at
  // midnight, and by the time it does the next row to land refreshes it.
  const dayMarks = useMemo(() => dayMarksByPosition(rows, new Date()), [rows])
  const lastRow = rows[rows.length - 1]?.row
  const tailState = transcriptTailState(activity, session, lastRow)
  // The trailing run has a call in flight, so it IS the end of the feed and the
  // tail stands down rather than spinning a second time beside it (POD-747).
  // A newly arriving run waits out its own zero-height unroll first: until the
  // row is visible, the generic tail remains the one live owner (POD-1334).
  const trailingRunLive = trailingRunIsLive(activity, lastRow)
  const runOwnsTail = useTrailingRunTailOwnership(trailingRunLive, lastRow, arriving)
  // Keep the SAME generic working state during the bridge. If the arriving call
  // is a shell/agent dependency, giving its still-hidden row to TranscriptTail
  // would morph the animated mark into a static wait diamond before the row can
  // take that wait itself — visually the same missing beat this bridge closes.
  const tailLastRow = trailingRunLive && !runOwnsTail ? undefined : lastRow
  // A live question is already the attention surface. Repeating the same
  // yellow signal in the tail weakens both objects, so the card owns it alone.
  // A state-drawn card is the same object and stands down the tail the same way
  // — the reader cannot tell (and must not need to tell) which source drew it.
  const questionOwnsAttention =
    (livePendingAskIndex >= 0 || pendingAskBlock !== null) && activity?.tone === 'attention'
  return (
    <div
      // Keyed on the wedge epoch (round 6): see `scrollerEpoch` above.
      key={scrollerEpoch}
      // Named so a portalled overlay hanging off a row can find the box it must
      // stay inside. A tooltip's default collision boundary is the VIEWPORT, and
      // the viewport does not stop at the feed — it continues down through the
      // composer, which is how the work-line preview came to cover the prompt
      // box. See WorkLinePreview in ToolBatchView.tsx.
      data-feed-scroller=""
      // The engine's end-of-feed anchor starts GRANTED because the pin starts
      // true; from here on use-transcript-scroll owns the attribute (revoked on
      // wheel/touch intent, re-armed on downward movement). See the anchor
      // rules in styles.css (POD-1160) for why eligibility must follow intent.
      data-anchor-end=""
      className={cn(
        // COLUMN-REVERSE (round 8): the scroller's resting origin IS the bottom.
        // Following a streaming transcript needs zero scroll writes — content
        // growth pushes history upward while the reader rests at origin — so
        // Safari 26.4's frozen scrolling node (which restores its remembered
        // origin after every commit) restores... the bottom. The rows keep
        // their normal top-to-bottom DOM order inside the single .feed-column
        // wrapper below, so selection, find and screen-reader order are
        // untouched. Validated in the operator's own Safari with a static
        // probe before this landed.
        'flex min-w-0 flex-1 flex-col-reverse gap-0 overflow-x-clip overflow-y-auto',
        // NO `overflow-anchor: none` HERE, AND THAT IS THE WHOLE SAFARI BUG.
        //
        // Round 3 turned the browser's scroll anchoring off on this scroller, on
        // the argument that the feed already has its own explicit versions of it
        // — `prependAnchor` for paging older rows in, the pinned re-snap for the
        // tail — and that two mechanisms writing `scrollTop` disagree. The
        // reasoning was sound for Chromium and it was applied blind to
        // everything else: WebKit had no scroll anchoring, so the declaration
        // read as a no-op there.
        //
        // Safari 26 ships scroll anchoring, and `overflow-anchor: none` on this
        // scroller makes WebKit under-compute the scrollable overflow region.
        // Measured on the live feed: the reported maximum
        // (`scrollHeight - clientHeight`) sat 444px above the maximum
        // `scrollTop` would actually accept, and the last rows were laid out
        // 430px BELOW the scrollport with no way to scroll to them. That is
        // every symptom the operator reported, in one line — the feed "opened
        // short", "jump to bottom" reached a maximum that was not the end, and
        // scrolling past it was undone. Setting the property back to `auto` on
        // the live page closed the gap to 0 and the overhang to −14px, which is
        // just the feed's own bottom padding. No other property moved it:
        // block layout, no padding, no sticky descendants, no transforms, no
        // containment all measured identically to baseline.
        //
        // So the declaration goes. What it was defending against is now handled
        // where it belongs: the prepend anchor is consume-or-clear, and the pin
        // re-snaps from an observer that sees every child, including the ones
        // that mount between row commits (POD-993 round 6).
        // §2.5 feed geometry: 12px/14px padding in the narrow column.
        //
        // THE MEASURE RETURNS, CENTRED (POD-993 round 2). POD-747 removed every
        // cap here, and it was right about what it was fixing: there were two
        // nested caps producing three different right edges inside one pane, with
        // the composer and the tail running full width underneath them. What it
        // put in place — the pane IS the measure — reads well up to about a
        // thousand pixels and then stops: dragged to a 1600px stage the document
        // sets 150-character lines, which is past the width at which the eye can
        // find the start of the next one.
        //
        // So there is ONE cap, and it is on the column rather than on anything
        // inside it: an 888px measure, centred, with a 32px gutter that wins
        // whenever the pane is narrower than the measure. Every voice obeys it
        // because it is the scroller's own padding — nothing inside sets a width,
        // so the failure POD-747 documented cannot come back. Below ~950px the
        // expression collapses to exactly the flat 32px inset, which is the
        // behaviour of the version this replaces.
        //
        // The rail's width comes OUT of the expression because a percentage in
        // `padding` resolves against the CONTAINING BLOCK — here the box holding
        // this scroller AND the reading rail beside it, not this scroller. The
        // pinned brief's shelf uses the identical expression so the two share one
        // measure; see `.brief-shelf-layer` in styles.css.
        compact
          ? 'px-3.5 pt-3 pb-4'
          : 'px-[max(32px,calc((100%-888px-var(--chat-rail-w,0px))/2))] pt-[26px] pb-[14px]',
      )}
      ref={scrollerRef}
      onScroll={onScroll}
    >
      {/* The single flex item the reversed scroller lays out at its bottom
          edge. Inside it everything is a normal column in normal DOM order —
          see the class note above. `min-h-full` keeps the auto-margin spacer
          working for short conversations. */}
      <div className="feed-column flex min-h-full min-w-0 flex-col">
      {/* A short conversation sits ON the composer instead of stranded at the
          top of an empty scrollport. An auto-margin spacer rather than
          `justify-end`, which makes overflow past the START edge unreachable in
          some engines: this collapses to zero the moment the feed overflows, so
          the scroll math never sees it. Every phase takes it: a state that
          resolves into content must occupy where that content will be (POD-700),
          and the standby's question belongs on the composer it is asking the
          reader to type into rather than centred in a void (POD-746). */}
      <div className="mt-auto" aria-hidden="true" />
      {phase === 'loading' && <TranscriptCold compact={compact} />}
      {phase === 'empty' && (
        <TranscriptStandby session={session} cwd={cwd} superagent={superagent} />
      )}
      {/* Top sentinel: only the bounded tail of ROWS is mounted; more exist
          above (windowed-out locally or still on disk). Scrolling here autoloads
          them (onScroll → loadOlder); this is also a manual fallback if the
          scroll trigger is missed. */}
      {blocks.length > 0 && moreAbove && (
        <button
          data-pressable
          type="button"
          onClick={loadOlder}
          disabled={loadingOlder}
          className="transcript-pager"
          aria-live="polite"
        >
          {loadingOlder ? (
            <>
              <ArrowUp size={11} aria-hidden="true" />
              <strong>Earlier transcript</strong>
              <span>loading…</span>
            </>
          ) : (
            <>
              <ArrowUp size={11} aria-hidden="true" />
              <strong>Earlier transcript</strong>
              <span>loads automatically · click to retry</span>
            </>
          )}
        </button>
      )}
      {rows.map(({ row, index: idx }, pos) => {
        // An operator prompt opens an exchange — except at the very top of the
        // mounted window, where the air would only pad the scrollport (and
        // where the row is often the sticky continuation of an exchange whose
        // opening is scrolled away above).
        const turn: TurnPosition | undefined =
          pos > 0 && isOperatorPromptRow(row) ? 'open' : turnPosition(row)
        const arrived = arriving.has(rowIdentity(row))
        // THE DAY MARK (POD-701). A per-row clock is ambiguous the moment a
        // session outlives a day, so each date boundary states itself once and
        // resolves every clock beneath it. The leading mark is emitted only when
        // the window does NOT open on today: "Today" over a transcript that is
        // entirely from today is a line that tells the reader nothing.
        const dayMark = dayMarks.get(pos)
        // Absolute row index into `rows` keeps minimap/search and
        // [data-block] aligned even for the one-row sticky continuation.
        const rowNode =
          row.kind === 'tools' ? (
            <ToolBatchView
              // A tools row always folds ≥1 block, so [0] and blocks[bi] exist.
              key={`${idx}-${row.blocks[0]!.item.id}`}
              row={row}
              index={idx}
              highlighted={idx === search.activeRow}
              forceOpen={expandRuns || idx === search.activeRow}
              dimmed={search.filtering && !row.blockIndices.some((bi) => searchMatches.has(bi))}
              // The work line reads as LIVE only for the trailing run of a turn
              // with a call actually IN FLIGHT: the spinner and counting timer
              // are the motion grammar's "an agent is computing", and a run that
              // has been overtaken by prose — or whose last result has landed
              // while the agent thinks about the next step — is finished
              // whatever the session is doing now. It used to mean "the turn is
              // running", so a settled run kept spinning under the name of a
              // call that had already returned while the tail counted the same
              // turn beneath it (POD-747). MOUNT POSITION, not `idx`: `rows` is
              // the bounded trailing window and `idx` is the ABSOLUTE index into
              // the full row list, so the last mounted row is
              // `pos === rows.length - 1`.
              live={trailingRunLive && pos === rows.length - 1}
              ownsTail={runOwnsTail && pos === rows.length - 1}
              // The run that owns the tail also takes the tail's rule, so the
              // feed still ends on a line rather than trailing off mid-column.
              endsFeed={runOwnsTail && pos === rows.length - 1}
              waiting={
                pos === rows.length - 1 && tailState?.mode === 'wait'
                  ? { label: tailState.label, detail: tailState.detail }
                  : undefined
              }
              arrived={arrived}
              turn={turn}
              sessionId={sessionId}
              cwd={cwd}
              openFile={openFile}
            />
          ) : (
            <ChatBlockView
              key={`${idx}-${row.block.item.id}`}
              block={row.block}
              index={idx}
              markdownHtml={markdownHtml}
              highlighted={idx === search.activeRow}
              dimmed={search.filtering && !searchMatches.has(row.blockIndex)}
              sessionId={sessionId}
              cwd={cwd}
              openFile={openFile}
              httpOrigin={httpOrigin}
              onOpenImage={onOpenImage}
              // AskUserQuestion is its own block-row; light up the one that is the
              // latest unanswered question on a live session (livePendingAskIndex
              // indexes into `blocks`, matched here against the row's blockIndex).
              askLivePending={row.blockIndex === livePendingAskIndex}
              onAnswerAsk={onAnswerAsk}
              collapseContext={collapseContext}
              compact={compact}
              ctxSeq={compact && row.blockIndex === lastAnswerBlockIndex ? ctxSeq : null}
              stickyOperator={stickyEnabled && isOperatorPromptRow(row)}
              attribution={attributionForRole(attribution, row.block.item.role)}
              turn={turn}
              arrived={arrived}
              onQuote={onQuote}
              issueReferences={issueReferences}
            />
          )
        if (!dayMark) return rowNode
        return (
          <Fragment key={`day-${idx}`}>
            <div className="transcript-daymark" data-testid="transcript-daymark">
              <span className="transcript-daymark-label">{dayMark}</span>
            </div>
            {rowNode}
          </Fragment>
        )
      })}
      {pending.map((p) => (
        <div
          key={p.id}
          className={cn(
            // An optimistic bubble is the operator opening an exchange, and is
            // spaced like one — otherwise the feed's rhythm changes at the
            // moment the real row replaces it.
            'transcript-row transcript-turn-open',
            // THE MESSAGE IS ON SCREEN BEFORE THE WIRE KNOWS (POD-993). The
            // optimistic row plays the same arrival every landed row plays, so
            // pressing send reads as the message MOVING into the conversation
            // rather than as a row appearing where there wasn't one. The real
            // row replaces it in the same place, at the same measure, and the
            // swap is invisible.
            'transcript-pending transcript-arrive-bubble',
            p.state === 'failed' && 'transcript-pending--failed',
          )}
        >
          <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
          <div className="transcript-body transcript-you">
            <div className="transcript-you-bubble">
              <div className="transcript-you-body">
                <div className="chat-md whitespace-pre-wrap">{p.text}</div>
                {p.tags && p.tags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.tags.map((tag, i) => (
                      <span
                        key={`${tag.kind}-${i}`}
                        className="inline-flex items-center gap-1 rounded border border-input px-[7px] py-0.5 text-[11px] text-muted-foreground"
                      >
                        <ImageIcon size={12} aria-hidden="true" />
                        {tag.label ?? tag.kind}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {/* THE DELIVERY STATE IS THE CARD'S OWN CAPTION (POD-993) — no voice
                label, because the side already said who spoke.

                A message in flight says NOTHING here: the breath at the end of
                the feed is already the "this is happening" signal, and a second
                one under the card would be the same fact twice, competing with
                it. Only the two states the tail cannot express get a caption —
                waiting behind another turn, and not arriving at all.

                The word is PENDING, not "queued" — one noun for every
                not-yet-delivered bubble, whatever parked it (a hibernated
                session, a turn already in flight, a server that queued it).
                The delivered design said "queued"; main had already settled on
                "pending" for the same state, and one vocabulary matters more
                here than one word. */}
            {p.state !== 'sending' && (
              <div className="msg-foot" data-side="right">
                {p.state === 'queued' && (
                  <span className="transcript-delivery">
                    {queueIsBlocked(session) ? queuedDeliveryLabel(session) : 'pending'}
                  </span>
                )}
                {p.state === 'failed' && (
                  <span className="transcript-delivery transcript-delivery--error">
                    {p.failure ? `not delivered — ${p.failure}` : 'not delivered'}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      {/* THE QUEUED TURN (POD-993) — a message the operator has written and
          committed to, waiting behind the turn in flight. It is the one row in
          the feed that is not yet part of the conversation, so it does not wear
          the settled card: same geometry and same side, but a DASHED rim over no
          fill — the shape of a thing whose place is reserved rather than taken —
          and dimmed until the pointer arrives. Its foot carries what it is
          waiting for and the way out: Retract sits with the other message
          actions, in one idiom, and only takes destructive ink under the
          pointer, because changing your mind is not an error.

          This foot is now the ONLY place the queue is stated: the composer used
          to repeat the count above the field, which said the same fact twice
          about the very bubble sitting an inch above it. So the wording the
          composer carried comes here — a parked session has no turn to send
          after, it has a process to start first (POD-762).

          AND THE RESERVATION ENDS WHERE THE HANDOVER BEGINS (POD-1242). Once the
          bytes are in the CLI the message is no longer waiting on us: it cannot
          be retracted, and the agent is very often already acting on it — Claude
          Code shows queued input to the turn in flight, which is how an operator
          watched a merge run tool by tool while the bubble underneath it still
          read "pending · sends after this turn". So an injected row drops the
          dashed rim and the whole foot and takes its place as a settled card: the
          same silence a message in flight keeps everywhere else in this feed. A
          WAKING session is the exception — its row is queued for a process that
          does not exist yet, so the stamp says nothing about a CLI and the
          reservation stands. */}
      {restoredQueued.map((message) => {
        const handedOver =
          message.injectedAt !== null && !sessionWaking(session) && !queueIsBlocked(session)
        return (
          <div
            key={message.id}
            className="transcript-row transcript-turn-open transcript-arrive-bubble"
            data-testid="queued-chat-message"
          >
            <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
            <div className="transcript-body transcript-you">
              <div
                className={cn(
                  'transcript-you-bubble',
                  !handedOver && 'transcript-you-bubble--queued',
                )}
              >
                <div className="transcript-you-body">
                  <div className="chat-md whitespace-pre-wrap">{message.text}</div>
                </div>
              </div>
              {!handedOver && (
                <div className="msg-foot" data-side="right">
                  <span className="transcript-delivery">
                    {queuedDeliveryLabel(session)}
                  </span>
                  <button
                    data-pressable
                    type="button"
                    className="msg-action msg-action--retract"
                    aria-label="Retract pending message"
                    title="Retract pending message"
                    onClick={() => void onRetractQueued(message.id)}
                  >
                    <MetaGlyph name="close" />
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      })}
      {/* Headless streaming overlay: the in-progress assistant text (or the
          driver's status label) below the last transcript row. Replaced by
          the real item when it lands via the transcript tail; cleared on
          turn-end. Native sessions never emit these frames. */}

      {/* A dead letter is terminal delivery history: the transcript provider
          cannot echo it because the session never took the turn. Keep the
          durable attempt visible and retry by making a fresh normal send. */}
      {restoredFailed.map((message) => (
        <div
          key={message.id}
          className="transcript-row transcript-turn-open transcript-pending transcript-pending--failed"
          data-testid="dead-lettered-chat-message"
        >
          <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
          <div className="transcript-body transcript-you">
            <div className="transcript-you-bubble">
              <div className="transcript-you-body">
                <div className="chat-md whitespace-pre-wrap">{message.text}</div>
              </div>
            </div>
            <div className="msg-foot" data-side="right">
              <span className="transcript-delivery transcript-delivery--error">
                {message.failure}
              </span>
              {onRetryFailed && (
                <button
                  data-pressable
                  type="button"
                  className="msg-action"
                  aria-label="Retry failed message"
                  title="Retry failed message"
                  onClick={() => onRetryFailed(message.text)}
                >
                  <RotateCcw size={12} strokeWidth={1.7} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
      {/* The text carries a caret while it is still being written (POD-423):
          the overlay exists only mid-turn, so its presence IS the signal, and
          it goes away when the finished item takes over. */}
      {overlay && (
        <div className="transcript-row" data-headless-overlay>
          <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
          <div className="transcript-body">
            {overlay.text !== undefined && (
              <StreamingMarkdown text={overlay.text} issueReferences={issueReferences} />
            )}
            {overlay.status && (
              <div className="mt-1 text-xs text-muted-foreground italic">{overlay.status}</div>
            )}
          </div>
        </div>
      )}
      {/* The question Claude Code has not written down yet (POD-1273). A
          pending AskUserQuestion reaches the hook channel immediately but the
          transcript only once it RESOLVES, so for the whole time the agent is
          waiting there is no item to render — the state carries the ask instead
          and the same card draws it here, at the end of the feed where the item
          itself will land. It disappears on answer, when the session leaves
          `needs_user`; the transcript item then arrives on its own clock and
          stands as history. */}
      {pendingAskBlock && (
        <ChatBlockView
          block={pendingAskBlock}
          index={rows.length}
          markdownHtml={markdownHtml}
          highlighted={false}
          dimmed={false}
          sessionId={sessionId}
          cwd={cwd}
          openFile={openFile}
          httpOrigin={httpOrigin}
          onOpenImage={onOpenImage}
          askLivePending={true}
          onAnswerAsk={onAnswerAsk}
          collapseContext={collapseContext}
          compact={compact}
          attribution={attributionForRole(attribution, 'tool')}
          issueReferences={issueReferences}
        />
      )}
      {/* Where the transcript ENDS: working, waiting on you, or idle — one
          object in three weights (TranscriptTail). The headless driver's own
          status line already says what the agent is doing, so the tail defers
          to it and falls back to the idle clock underneath — and it defers the
          same way to a run with a call in flight, which is already spinning,
          already naming the call and already counting it (POD-747).

          THE SLOT STANDS WHETHER OR NOT A TAIL IS DUE (POD-1290 follow-up).
          The tail remounts on every phase change (key={kind}, the morph) and
          is absent entirely when idle — both right visually, and each one a
          height change at the very bottom of a pinned feed, which in release
          Safari paints as a small hop: the compositor shows a frame of the
          old offset before the corrective write lands, and an unmount invites
          the engine to clamp up by the vanished height first. The slot never
          changes size (min-height covers the tallest variant, styles.css), so
          phase changes and idle transitions move NO geometry — and as the
          feed's permanent last child it also gives the anchoring-engine
          regime ([data-anchor-end] > :last-child) a node that survives every
          phase to anchor to. */}
      <div className="feed-tail-slot" data-testid="feed-tail-slot">
        {(phase === 'ready' || activity?.tone === 'working') &&
          !questionOwnsAttention &&
          !runOwnsTail && (
            <TranscriptTail
              activity={overlay?.status ? null : activity}
              since={session?.agentState?.since}
              session={session}
              lastRow={tailLastRow}
            />
          )}
      </div>
      </div>
    </div>
  )
}
