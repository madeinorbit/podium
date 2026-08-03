import type {
  ChatActivity,
  ChatBlock,
  RenderableRow,
  TranscriptAttributionTable,
  TranscriptPhase,
  TranscriptSearchState,
} from '@podium/client-core/viewmodels'
import { attributionForRole, blockMatches } from '@podium/client-core/viewmodels'
import type { SessionId, SessionMeta } from '@podium/model'
import { Image as ImageIcon } from 'lucide-react'
import type { JSX, RefObject } from 'react'
import { renderMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import { ChatBlockView } from './ChatBlockView'
import type { PendingItem, QueuedChatMessage } from './chat'
import { SinceStopTimer } from './SinceStopTimer'
import { ToolBatchView } from './ToolBatchView'
import type { HeadlessOverlay } from './use-headless-turn'

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
  scrollerRef,
  onScroll,
  compact,
  phase,
  rows,
  blocks,
  search,
  query,
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
  lastAnswerBlockIndex,
  ctxSeq,
  collapseContext,
  stickyEnabled,
  isOperatorPromptRow,
  pending,
  restoredQueued,
  overlay,
  activity,
  attribution,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  compact: boolean
  phase: TranscriptPhase
  rows: readonly RenderableRow[]
  blocks: readonly ChatBlock[]
  search: TranscriptSearchState
  /** The raw query, for the per-block dimming predicate. `search` says WHICH row
   *  is active; the query says which rows are merely not matches. */
  query: string
  moreAbove: boolean
  loadingOlder: boolean
  loadOlder: () => void
  sessionId: SessionId
  cwd: string
  session: SessionMeta | undefined
  httpOrigin: string
  openFile: (sessionId: SessionId, path: string) => void
  onOpenImage: (url: string) => void
  onAnswerAsk: (choices: { optionIndices: number[] }[]) => Promise<void>
  livePendingAskIndex: number
  lastAnswerBlockIndex: number
  ctxSeq: number | null
  collapseContext: boolean
  stickyEnabled: boolean
  isOperatorPromptRow: (row: RenderableRow['row']) => boolean
  pending: readonly PendingItem[]
  restoredQueued: readonly QueuedChatMessage[]
  overlay: HeadlessOverlay | null
  activity: ChatActivity | null
  /** The session's three attribution pairs (doc §3.1.3 A3), derived once by the
   *  slice. Each row picks its pair by role; the objects are stable, so the
   *  memoized block views keep skipping renders. */
  attribution: TranscriptAttributionTable
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-col gap-0 overflow-x-clip overflow-y-auto',
        // §2.5 feed geometry: 12px/14px padding in the narrow column.
        compact ? 'px-3.5 pt-3 pb-4' : 'px-5 pt-5 pb-6',
      )}
      ref={scrollerRef}
      onScroll={onScroll}
    >
      {phase === 'loading' && (
        <div
          className="mx-auto my-8 flex items-center gap-2 text-[13px] text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <span
            className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
            aria-hidden="true"
          />
          Loading transcript…
        </div>
      )}
      {phase === 'empty' && (
        <div className="mx-auto my-6 max-w-[52ch] text-center text-[13px] text-muted-foreground/70">
          No transcript yet. For Claude, Codex, and Grok sessions the feed starts with the first
          prompt; shells have no structured transcript.
        </div>
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
          className="mx-auto my-1 inline-flex items-center gap-2 text-[12px] text-muted-foreground/70 hover:text-foreground disabled:cursor-default"
          aria-live="polite"
        >
          {loadingOlder ? (
            <>
              <span
                className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
                aria-hidden="true"
              />
              Loading earlier messages…
            </>
          ) : (
            'Load earlier messages'
          )}
        </button>
      )}
      {rows.map(({ row, index: idx }) =>
        // Absolute row index into `rows` keeps minimap/search and
        // [data-block] aligned even for the one-row sticky continuation.
        row.kind === 'tools' ? (
          <ToolBatchView
            // A tools row always folds ≥1 block, so [0] and blocks[bi] exist.
            key={`${idx}-${row.blocks[0]!.item.id}`}
            row={row}
            index={idx}
            highlighted={idx === search.activeRow}
            forceOpen={idx === search.activeRow}
            dimmed={
              search.filtering && !row.blockIndices.some((bi) => blockMatches(blocks[bi]!, query))
            }
            sessionId={sessionId}
            cwd={cwd}
            openFile={openFile}
          />
        ) : (
          <ChatBlockView
            key={`${idx}-${row.block.item.id}`}
            block={row.block}
            index={idx}
            highlighted={idx === search.activeRow}
            dimmed={search.filtering && !blockMatches(row.block, query)}
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
          />
        ),
      )}
      {pending.map((p) => (
        <div
          key={p.id}
          className={cn(
            'transcript-row mx-auto w-full max-w-[960px]',
            p.state === 'failed' && 'opacity-60',
          )}
        >
          <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
          <div className="transcript-body transcript-you">
            <div className="transcript-you-label">
              You
              {p.state === 'sending' && (
                <span className="ml-2 tracking-normal normal-case opacity-60">sending…</span>
              )}
              {p.state === 'queued' && (
                <span className="ml-2 tracking-normal normal-case text-warning">queued</span>
              )}
              {p.state === 'failed' && (
                <span className="ml-2 tracking-normal normal-case text-destructive">
                  not delivered
                </span>
              )}
            </div>
            <div className="chat-md whitespace-pre-wrap">{p.text}</div>
            {p.tags && p.tags.length > 0 && (
              <div className="mt-1.5 flex gap-1.5">
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
      ))}
      {restoredQueued.map((message) => (
        <div
          key={message.id}
          className="transcript-row mx-auto w-full max-w-[960px]"
          data-testid="queued-chat-message"
        >
          <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
          <div className="transcript-body transcript-you">
            <div className="transcript-you-label">
              You
              <span className="ml-2 tracking-normal normal-case text-warning">queued</span>
            </div>
            <div className="chat-md whitespace-pre-wrap">{message.text}</div>
          </div>
        </div>
      ))}
      {/* Headless streaming overlay: the in-progress assistant text (or the
          driver's status label) below the last transcript row. Replaced by
          the real item when it lands via the transcript tail; cleared on
          turn-end. Native sessions never emit these frames. */}
      {overlay && (
        <div className="transcript-row mx-auto w-full max-w-[960px]" data-headless-overlay>
          <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
          <div className="transcript-body">
            {overlay.text !== undefined && (
              <div
                className="chat-md opacity-80"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify
                dangerouslySetInnerHTML={{ __html: renderMarkdown(overlay.text) }}
              />
            )}
            {overlay.status && (
              <div className="mt-1 text-xs text-muted-foreground italic">{overlay.status}</div>
            )}
          </div>
        </div>
      )}
      {activity && !overlay?.status && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            // Match the shared status palette: working → the theme's live
            // hue, needs-you → warning, everything else muted.
            'mx-auto flex w-full max-w-[960px] items-center gap-2 py-3 pl-[calc(3px+12px)] text-xs',
            activity.tone === 'attention'
              ? 'text-warning'
              : activity.tone === 'working'
                ? 'text-live'
                : 'text-muted-foreground',
          )}
        >
          <span className="inline-flex gap-0.5">
            <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.2s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.1s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-current" />
          </span>
          {activity.label}
        </div>
      )}
      {/* General live timer since the agent last stopped — shown when it's
          idle (no active working/attention indicator). */}
      {!activity && session?.agentState?.since && (
        <SinceStopTimer since={session.agentState.since} />
      )}
    </div>
  )
}
