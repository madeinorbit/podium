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
import type { JSX, RefCallback, UIEventHandler } from 'react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { renderMarkdown, sanitizeRenderedMarkdown } from '@/lib/markdown'
import { renderMarkdownUnsafe } from '@/lib/markdown-renderer'
import { cn } from '@/lib/utils'
import { ChatBlockView, type ProcessPosition, type TurnPosition } from './ChatBlockView'
import type { ProjectedPendingItem, QueuedChatMessage } from './chat'
import type { DeadLetteredChatMessage } from './chat'
import { MetaGlyph } from './MetaGlyph'
import { ToolBatchView } from './ToolBatchView'
import { TranscriptCold } from './TranscriptCold'
import { TranscriptStandby } from './TranscriptStandby'
import { TranscriptTail, trailingRunIsLive } from './TranscriptTail'
import { transcriptComputeClient } from './transcript-compute-client'
import { dayKey, dayLabel, rowTimestamp } from './transcript-time'
import { rowIdentity, useFeedArrivals } from './use-feed-arrivals'
import type { HeadlessOverlay } from './use-headless-turn'
import type { TurnPreview } from './use-turn-preview'

/** Render a live partial through the same worker boundary as settled messages. */
function StreamingMarkdown({ text }: { text: string }): JSX.Element {
  const client = transcriptComputeClient()
  const [computed, setComputed] = useState<{ text: string; unsafeHtml: string } | null>(null)

  useEffect(() => {
    if (!client.usesWorker) return
    let cancelled = false
    // Provider deltas can arrive token by token. Wait for a short quiet edge so
    // superseded partials do not fill the shared worker queue ahead of settled
    // transcript indexing and search requests.
    const timer = window.setTimeout(() => {
      void client.computeMarkdown(text, renderMarkdownUnsafe).then(
        (unsafeHtml) => {
          if (!cancelled) setComputed({ text, unsafeHtml })
        },
        () => {
          if (!cancelled) setComputed({ text, unsafeHtml: renderMarkdownUnsafe(text) })
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
export function queuePositionSuffix(position: number | undefined): string {
  return typeof position === 'number' && Number.isInteger(position) && position > 0
    ? ` · queue position ${position}`
    : ''
}

export function queuedDeliveryLabel(
  session: SessionMeta | undefined,
  position?: number,
): string {
  const error = queueIsBlocked(session) ? session?.agentState?.error : undefined
  if (error) {
    const instruction = agentErrorRecoveryInstruction(error).replace(/\.$/, '')
    return `blocked · ${formatAgentError(error)} — ${instruction} to send${queuePositionSuffix(position)}`
  }
  const label = sessionWaking(session)
    ? 'pending · sends once the agent is up'
    : 'pending · sends after this turn'
  return `${label}${queuePositionSuffix(position)}`
}

/** Public process narration is visible transcript content, not hidden chain of
 * thought. It includes the assistant's intermediate commentary and the tool
 * activity that commentary introduces, then ends before the final answer. */
export function isProcessRow(row: ChatRow): boolean {
  if (row.kind === 'tools') return true
  const { item } = row.block
  if (item.role === 'assistant') return !item.answer
  if (item.role === 'tool') return !isInteractiveTool(item)
  return false
}

export function processPosition(
  row: ChatRow,
  previous: ChatRow | undefined,
): ProcessPosition | undefined {
  if (!isProcessRow(row)) return undefined
  return previous && isProcessRow(previous) ? 'continue' : 'start'
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
export function TranscriptFeed({
  setScrollerRef,
  setContentRef,
  onScroll,
  onPointerUp,
  compact,
  superagent,
  phase,
  rows,
  blocks,
  markdownHtml,
  search,
  revealedRow,
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
  turnPreview,
  activity,
  attribution,
  expandRuns = false,
  onQuote,
}: {
  setScrollerRef: RefCallback<HTMLDivElement>
  setContentRef: RefCallback<HTMLDivElement>
  onScroll: UIEventHandler<HTMLDivElement>
  onPointerUp: () => void
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
  /** Absolute row requested by an external transcript deep-link. */
  revealedRow?: number
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
  pending: readonly ProjectedPendingItem[]
  restoredQueued: readonly QueuedChatMessage[]
  restoredFailed?: readonly DeadLetteredChatMessage[]
  onRetractQueued: (id: string) => Promise<void>
  onRetryFailed?: (text: string) => void
  overlay: HeadlessOverlay | null
  /** The in-progress half of the open turn (POD-2293) — assistant text still
   *  being written and tool calls still running, for driver-backed sessions.
   *  Null for every session that produces no fragments, which is what keeps a
   *  PTY chat byte-identical to what it renders today. */
  turnPreview: TurnPreview | null
  activity: ChatActivity | null
  /** The session's three attribution pairs (doc §3.1.3 A3), derived once by the
   *  slice. Each row picks its pair by role; the objects are stable, so the
   *  memoized block views keep skipping renders. */
  attribution: TranscriptAttributionTable
  /** Verbose mode (POD-376): every run renders already unfolded. Verbose changes
   *  how a run LOOKS, not which rows exist, so it rides down here rather than
   *  through the row derivation. */
  expandRuns?: boolean
  /** Quote a message into the composer (POD-376 per-message actions). Absent →
   *  the Quote action is not offered, which is what a host without a composer
   *  should get rather than a button that does nothing. */
  onQuote?: (markdown: string) => void
}): JSX.Element {
  // Which rows LANDED, as opposed to which rows merely rendered — see
  // use-feed-arrivals. Identity is per row and index-free, so paging older
  // messages in above does not read as the whole feed arriving at once.
  const arriving = useFeedArrivals(useMemo(() => rows.map(({ row }) => rowIdentity(row)), [rows]))
  const searchMatches = useMemo(() => new Set(search.matches), [search.matches])
  // Recomputed with the rows rather than on a clock: "Today" only goes stale at
  // midnight, and by the time it does the next row to land refreshes it.
  const previewHasText =
    turnPreview?.items.some((item) => item.kind === 'text') === true

  const dayMarks = useMemo(() => dayMarksByPosition(rows, new Date()), [rows])
  const lastRow = rows[rows.length - 1]?.row
  const tailActivity: ChatActivity | null = overlay?.status
    ? { tone: 'working', label: overlay.status }
    : activity
  const trailingRunLive = trailingRunIsLive(tailActivity, lastRow)
  // A live question is already the attention surface. Repeating the same
  // yellow signal in the tail weakens both objects, so the card owns it alone.
  // A state-drawn card is the same object and stands down the tail the same way
  // — the reader cannot tell (and must not need to tell) which source drew it.
  const questionOwnsAttention =
    (livePendingAskIndex >= 0 || pendingAskBlock !== null) && activity?.tone === 'attention'
  return (
    <div
      // Named so a portalled overlay hanging off a row can find the box it must
      // stay inside. A tooltip's default collision boundary is the VIEWPORT, and
      // the viewport does not stop at the feed — it continues down through the
      // composer, which is how the work-line preview came to cover the prompt
      // box. See WorkLinePreview in ToolBatchView.tsx.
      data-feed-scroller=""
      className={cn(
        // The scrollport is deliberately NOT a flex container. The maintained
        // follow primitive observes the one child below; making that child a
        // shrinkable flex item lets its border box remain viewport-height while
        // descendants overflow it, so ResizeObserver misses message growth even
        // though scrollHeight changed. A plain scrollport + growing content box
        // is the geometry the browser and the observer agree on.
        'min-w-0 flex-1 overflow-x-clip overflow-y-auto overscroll-y-contain',
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
        // inside it: a 74-character measure, centred, with a 32px gutter that wins
        // whenever the pane is narrower than the measure. Every voice obeys it
        // because it is the scroller's own padding — nothing inside sets a width,
        // so the failure POD-747 documented cannot come back. On narrower panes the
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
          : 'px-[max(32px,calc((100%-var(--chat-reading-measure)-var(--chat-rail-w,0px))/2))] pt-[26px] pb-[14px]',
      )}
      ref={setScrollerRef}
      onScroll={onScroll}
      onPointerUp={onPointerUp}
    >
      {/* One observed content column in normal DOM order. `min-h-full` keeps
          the auto-margin spacer working for short conversations. */}
      <div ref={setContentRef} className="feed-column flex min-h-full min-w-0 flex-col">
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
          const process = processPosition(row, rows[pos - 1]?.row)
          const arrived = arriving.has(rowIdentity(row))
          const identity = rowIdentity(row)
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
                key={identity}
                row={row}
                index={idx}
                highlighted={idx === search.activeRow || idx === revealedRow}
                forceOpen={expandRuns || idx === search.activeRow || idx === revealedRow}
                dimmed={search.filtering && !row.blockIndices.some((bi) => searchMatches.has(bi))}
                // The work line names an in-flight call only when it is the
                // trailing row. The permanent tail below remains the one owner of
                // live motion, so a tool-result commit cannot remove the working
                // indicator. MOUNT POSITION, not `idx`: `rows` is the bounded
                // trailing window while `idx` is the absolute index.
                live={trailingRunLive && pos === rows.length - 1}
                ownsTail={false}
                arrived={arrived}
                turn={turn}
                process={process}
                sessionId={sessionId}
                cwd={cwd}
                openFile={openFile}
              />
            ) : (
              <ChatBlockView
                key={identity}
                block={row.block}
                index={idx}
                markdownHtml={markdownHtml}
                highlighted={idx === search.activeRow || idx === revealedRow}
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
                process={process}
                arrived={arrived}
                onQuote={onQuote}
              />
            )
          if (!dayMark) return rowNode
          return (
            <Fragment key={`day-${identity}`}>
              <div className="transcript-daymark" data-testid="transcript-daymark">
                <span className="transcript-daymark-label">{dayMark}</span>
              </div>
              {rowNode}
            </Fragment>
          )
        })}
        {pending.map((p) => {
          const durable = p.durable
          const queuePosition = durable ? durable.queuePosition : p.queuePosition
          const handedOver =
            durable?.injectedAt != null && !sessionWaking(session) && !queueIsBlocked(session)
          return (
            <div
              key={p.id}
              data-testid={durable ? 'queued-chat-message' : undefined}
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
                <div
                  className={cn(
                    'transcript-you-bubble',
                    durable && !handedOver && 'transcript-you-bubble--queued',
                  )}
                >
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
            {p.state === 'interrupted' ? (
              <div className="msg-foot" data-side="right">
                <span className="transcript-delivery">interrupted</span>
              </div>
            ) : durable && !handedOver ? (
              <div className="msg-foot" data-side="right">
                <span className="transcript-delivery">
                  {queuedDeliveryLabel(session, queuePosition)}
                </span>
                <button
                  data-pressable
                  type="button"
                  className="msg-action msg-action--retract"
                  aria-label="Retract pending message"
                  title="Retract pending message"
                  onClick={() => void onRetractQueued(durable.id)}
                >
                  <MetaGlyph name="close" />
                </button>
              </div>
            ) : p.state !== 'sending' && !handedOver ? (
              <div className="msg-foot" data-side="right">
                {p.state === 'queued' && (
                  <span className="transcript-delivery">
                    {queueIsBlocked(session)
                      ? queuedDeliveryLabel(session, queuePosition)
                      : `pending${queuePositionSuffix(queuePosition)}`}
                  </span>
                )}
                {p.state === 'failed' && (
                  <span className="transcript-delivery transcript-delivery--error">
                    {p.failure ? `not delivered — ${p.failure}` : 'not delivered'}
                  </span>
                )}
              </div>
            ) : null}
              </div>
            </div>
          )
        })}
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
          fresh harness interrupt is the exception: the server cancels that row
          and the local outgoing bubble names the interrupted result. A
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
                    {queuedDeliveryLabel(session, message.queuePosition)}
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
        {overlay?.text !== undefined && !previewHasText && (
          <div
            className={cn(
              'transcript-row transcript-process-row',
              !lastRow || !isProcessRow(lastRow) ? 'transcript-process-start' : undefined,
            )}
            data-headless-overlay
          >
            <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
            <div className="transcript-body">
              {(!lastRow || !isProcessRow(lastRow)) && (
                <div className="transcript-process-label">Process</div>
              )}
              <StreamingMarkdown text={overlay.text} />
            </div>
          </div>
      )}
      {/* THE IN-PROGRESS TURN (POD-2293), in the position its durable items will
          occupy. Each row disappears when the item carrying its identity lands
          on the transcript plane — the server retires it there, so a row still
          drawn here is one the transcript genuinely does not have yet.

          Deliberately LIGHTER than the blocks below it: assistant text renders
          through the same StreamingMarkdown the headless overlay uses, and a
          running tool is one muted line rather than a ToolBlock. A preview row
          that looked identical to a finished one would be claiming a result it
          does not have. */}
      {turnPreview && turnPreview.items.length > 0 && (
        <div className="transcript-row" data-turn-preview>
          <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
          <div className="transcript-body">
            {turnPreview.items.map((item) =>
              item.kind === 'text' ? (
                <StreamingMarkdown
                  key={item.itemId}
                  text={item.text}
                />
              ) : (
                <div
                  key={item.itemId}
                  className="mt-1 text-xs text-muted-foreground italic"
                  data-turn-preview-tool
                >
                  {item.item.toolName ?? 'tool'}
                  {item.item.toolInput ? ` ${item.item.toolInput}` : ''}
                </div>
              ),
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
          />
        )}
        {/* Where the transcript ENDS: the single live-status owner. Tool rows and
          headless status frames can refine its wording but never replace it.

          THE SLOT STANDS WHETHER OR NOT A TAIL IS DUE (POD-1290 follow-up).
          The tail remounts on every phase change (key={kind}, the morph) and
          is absent entirely when idle — both right visually, and each one a
          height change at the very bottom of a pinned feed, which in release
          Safari paints as a small hop: the compositor shows a frame of the
          old offset before the corrective write lands, and an unmount invites
          the engine to clamp up by the vanished height first. The slot never
          changes size (min-height covers the tallest variant, styles.css), so
          phase changes and idle transitions move NO geometry — and as the
          feed's permanent last child it avoids bottom-geometry churn. */}
        <div className="feed-tail-slot" data-testid="feed-tail-slot">
          {(phase === 'ready' || tailActivity?.tone === 'working') && !questionOwnsAttention && (
            <TranscriptTail
              activity={tailActivity}
              since={session?.agentState?.since}
              session={session}
              lastRow={lastRow}
            />
          )}
        </div>
      </div>
    </div>
  )
}
