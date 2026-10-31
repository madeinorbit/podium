import {
  formatChurn,
  formatTokens,
  isImagePath,
  isInteractiveTool,
  isInterviewQuestion,
  MACHINE_CONTEXT_RE,
  mcpLabel,
  messageAttachmentText,
  type TranscriptAttribution,
  transcriptActivityFacts,
} from '@podium/client-core/values'
import { codexQuestionReplyText } from '@podium/harness/browser'
import { machinePathBasename, resolveMachinePath } from '@podium/model'
import type { SessionId, TranscriptItem } from '@podium/model/browser'
import {
  ChevronRight,
  Clock,
  FilePen,
  FileText,
  Layers2,
  MessageCircleQuestion,
} from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { memo, useCallback, useId, useMemo, useRef, useState } from 'react'
import { assetUrl } from '@/lib/asset-url'
import { renderMarkdown, sanitizeRenderedMarkdown } from '@/lib/markdown'
import type { QuoteInput } from '@/lib/quote/quote-sinks'
import { useKnownRefPrefixesVersion } from '@/lib/use-known-ref-prefixes'
import { cn } from '@/lib/utils'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { AttributionMark } from './AttributionMark'
import { ChatUploadThumb, ItemAttachments, stagedAttachmentId } from './ChatUploadThumb'
import type { ChatBlock } from './chat'
import { handleChatMdClick } from './chat-md-click'
import { MachineContextRow } from './MachineContextRow'
import { InboxReadRow, SentNoteRow } from './MailCommandRow'
import { MessageEnvelopeGroup } from './MessageEnvelopeGroup'
import { MetaGlyph } from './MetaGlyph'
import type { MailReply } from './mail-reply'
import { SendUserFileBlock } from './SendUserFileBlock'
import { ToolBlock } from './ToolBlock'
import { clockLabel, fullTimeLabel, parseTs } from './transcript-time'
import { useChatItemMessage } from './use-chat-context'

/** A row's place in its exchange (POD-376). `open` puts the air of a turn
 *  boundary in front of the row; `bind` pulls machine activity up under the
 *  prose that produced it. Absent → the feed's ordinary beat. The rule that
 *  decides which is which lives in TranscriptFeed, where the whole row sequence
 *  is visible. */
export type TurnPosition = 'open' | 'bind'

/** A row inside the agent's visible working narrative. `start` draws the
 * register once; subsequent narration and tool runs continue the same region
 * without repeating it. Final answers and human prompts sit outside it. */
export type ProcessPosition = 'start' | 'continue'

export function turnClass(turn: TurnPosition | undefined): string | undefined {
  return turn === 'open'
    ? 'transcript-turn-open'
    : turn === 'bind'
      ? 'transcript-turn-bind'
      : undefined
}

export function processClass(process: ProcessPosition | undefined): string | undefined {
  return process === 'start'
    ? 'transcript-process-row transcript-process-start'
    : process === 'continue'
      ? 'transcript-process-row'
      : undefined
}

/** How long the copy button holds its acknowledgement before returning to rest. */
const COPY_ACK_MS = 1400

/**
 * PER-MESSAGE ACTIONS (POD-376). Measured before this: zero buttons on zero
 * messages — the transcript was a surface you could only read.
 *
 * Copy takes the message's own markdown, not the rendered HTML, because what a
 * reader pastes into an issue or a commit should be the text the agent wrote.
 * Quote hands the composer a blockquote so a reply can point at the line it is
 * answering.
 *
 * The foot follows the words in reading order. On agent prose its hover
 * controls sit beside the prose so hidden controls do not widen the transcript's
 * 12px beat. Human prompts keep their foot below the bubble and their turn seam.
 */
function MessageActions({
  text,
  onQuote,
  quoteSource,
  ts,
  side,
  children,
}: {
  text: string
  onQuote?: ((quote: QuoteInput) => void) | undefined
  /** What the quote button says this message is (see `quoteSourceLabel`). */
  quoteSource?: string | undefined
  /** The row's own instant. Every voice now carries one here — see the foot's
   *  note below for why the clock left the label rows. */
  ts?: string | undefined
  /** Alignment of metadata within the footer. */
  side: 'left' | 'right'
  /** Row-specific controls that belong with the metadata rather than with the
   *  message — the queued turn's Retract is the only one today. */
  children?: ReactNode
}): JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const ack = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copy = useCallback(() => {
    const clipboard = navigator.clipboard
    if (!clipboard) return
    void clipboard.writeText(text).then(() => {
      setCopied(true)
      if (ack.current) clearTimeout(ack.current)
      ack.current = setTimeout(() => setCopied(false), COPY_ACK_MS)
    })
  }, [text])
  const quote = useCallback(() => {
    onQuote?.({ text: text.trim(), source: quoteSource ?? 'a message' })
  }, [text, onQuote, quoteSource])
  const empty = !text.trim()
  if (empty && !children && !ts) return null
  return (
    <div className="msg-foot" data-side={side} data-testid="message-actions">
      {ts && <BlockClock ts={ts} />}
      {children}
      {!empty && (
        <span className="msg-tools">
          <button
            data-pressable
            type="button"
            className="msg-action"
            onClick={copy}
            title="Copy message"
            aria-label={copied ? 'Message copied' : 'Copy message'}
          >
            <MetaGlyph name={copied ? 'check' : 'copy'} />
          </button>
          {onQuote && (
            <button
              data-pressable
              type="button"
              className="msg-action"
              onClick={quote}
              title="Add to chat"
              aria-label="Add to chat"
            >
              <MetaGlyph name="quote" />
            </button>
          )}
        </span>
      )}
    </div>
  )
}

/**
 * WHEN (POD-701). A right-aligned mono clock at the end of a row's own label.
 * It used to render only in the narrow superagent dock (`compact`), so the chat
 * a reader actually lives in never said when anything happened — the one
 * question a transcript is most often re-opened to answer. It is now on every
 * labelled row at both widths.
 *
 * A real `<time>` with the ISO instant, and the full local date-and-seconds in
 * the tooltip: the visible figure is deliberately only hours and minutes, and a
 * reader who needs more should not have to leave the row to get it. Absent or
 * unparseable ts → nothing, never a fabricated time.
 */
/**
 * How a quote from this message names its origin to the agent (POD-2057). The
 * prompt is written by the operator, so "my" is theirs and "your" is the agent's.
 */
function quoteSourceLabel(isUser: boolean, ts: string | undefined): string {
  const d = parseTs(ts)
  const who = isUser ? 'my message' : 'your reply'
  return d ? `${who}, ${clockLabel(d)}` : who
}

function BlockClock({ ts }: { ts?: string | undefined }): JSX.Element | null {
  const d = parseTs(ts)
  if (!d || !ts) return null
  return (
    <time className="chat-clk" dateTime={ts} title={fullTimeLabel(d)}>
      {clockLabel(d)}
    </time>
  )
}

/**
 * THE BRIEF IN FLOW IS NEVER CUT AND NEVER MOVES (POD-993, round 2).
 *
 * POD-747 established that a brief is the one thing the reader wrote themselves,
 * so nothing in the column may truncate it. Round one honoured that but made the
 * row `position: sticky` with a clamp that engaged once it stuck — which changed
 * the height of the flow under the reader as it pinned.
 *
 * So the pin left the column. The brief here is only ever a brief: whole, in
 * flow, no clamp, no toggle, no sticky, no transform. The pinned state is a
 * separate SHELF over the feed — see `PinnedBrief` and `.brief-shelf-layer`.
 */
function PromptBubble({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="transcript-you-bubble">
      <div className="transcript-you-body">{children}</div>
    </div>
  )
}

/**
 * A settled message is a DOM island. Feed state (follow mode, timers, issue
 * updates, search chrome) may re-render its ancestors, but identical markdown
 * must not be assigned through `innerHTML` again: browsers discard the text
 * nodes that own an active selection when that happens. Primitive props plus
 * `memo` make the message body update only when its own content or link-routing
 * context actually changes.
 */
export const StableMarkdown = memo(function StableMarkdown({
  html,
  className = 'chat-md',
  sessionId,
  cwd,
  openFile,
}: {
  html: string
  className?: string
  sessionId: SessionId
  cwd: string
  openFile: (sessionId: SessionId, path: string) => void
}): JSX.Element {
  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      handleChatMdClick(event, sessionId, cwd, openFile)
    },
    [cwd, openFile, sessionId],
  )
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegated clicks activate semantic links in the sanitized markdown.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users activate those anchors natively.
    <div
      className={className}
      onClick={onClick}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify before this boundary
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

/** What the note's head says beside "Context compacted": how it was started
 *  and how far it shrank the context, when the harness recorded either. */
function compactionDetail(item: TranscriptItem): string {
  const meta = item.compaction
  const parts: string[] = []
  if (meta?.idle) parts.push('while idle')
  else if (meta?.trigger === 'manual') parts.push('on request')
  if (meta?.preTokens !== undefined && meta.postTokens !== undefined)
    parts.push(`${formatTokens(meta.preTokens)} → ${formatTokens(meta.postTokens)} tokens`)
  return parts.join(' · ')
}

/** Compaction is background context. Keep the summary readable on request and
 * expose it automatically when search lands inside it. One note stands for the
 * whole compaction: Claude's boundary and idle notice fold into it upstream. */
function CompactionNote({
  item,
  cls,
  index,
  highlighted,
  sessionId,
  cwd,
  openFile,
  markdownHtml,
  onQuote,
}: {
  item: TranscriptItem
  cls: string
  index: number
  highlighted: boolean
  sessionId: SessionId
  cwd: string
  openFile: (sessionId: SessionId, path: string) => void
  markdownHtml?: ReadonlyMap<string, string> | undefined
  onQuote?: ((quote: QuoteInput) => void) | undefined
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasSummary = item.text.trim() !== ''
  const open = hasSummary && (expanded || highlighted)
  const detail = compactionDetail(item)
  const bodyId = useId()
  const refPrefixesVersion = useKnownRefPrefixesVersion()
  const unsafeHtml = markdownHtml?.get(item.text)
  // biome-ignore lint/correctness/useExhaustiveDependencies: prefix registration changes reference links.
  const html = useMemo(() => {
    if (!open) return ''
    return unsafeHtml === undefined
      ? renderMarkdown(item.text)
      : sanitizeRenderedMarkdown(unsafeHtml)
  }, [open, unsafeHtml, item.text, refPrefixesVersion])
  return (
    <div className={cls} data-block={index} data-row-key={item.id} data-system-kind="compaction">
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body compaction-note">
        {hasSummary ? (
          <button
            type="button"
            className="compaction-note-head"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setExpanded((value) => !value)}
          >
            <Layers2 size={13} strokeWidth={1.5} aria-hidden="true" />
            <span className="compaction-note-label">Context compacted</span>
            {detail && (
              <span className="compaction-note-detail" title={item.compaction?.notice}>
                {detail}
              </span>
            )}
            <span className="compaction-note-action">{open ? 'Hide summary' : 'Show summary'}</span>
            <ChevronRight
              className="compaction-note-chevron"
              size={12}
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span className="compaction-note-rule" aria-hidden="true" />
            <BlockClock ts={item.ts} />
          </button>
        ) : (
          // The boundary arrives a moment before its summary; until then (or
          // when the summary sits outside the loaded window) there is nothing
          // to disclose.
          <div className="compaction-note-head compaction-note-head--static">
            <Layers2 size={13} strokeWidth={1.5} aria-hidden="true" />
            <span className="compaction-note-label">Context compacted</span>
            {detail && (
              <span className="compaction-note-detail" title={item.compaction?.notice}>
                {detail}
              </span>
            )}
            <span className="compaction-note-rule" aria-hidden="true" />
            <BlockClock ts={item.ts} />
          </div>
        )}
        <div id={bodyId} hidden={!open} className="compaction-note-body">
          {open && (
            <>
              <StableMarkdown html={html} sessionId={sessionId} cwd={cwd} openFile={openFile} />
              <MessageActions
                text={item.text}
                onQuote={onQuote}
                quoteSource="the context compaction summary"
                side="left"
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Memoized: ChatView re-renders on every search keystroke, every 700ms
// transcript poll, and every session-state change in the store. Block identity
// is stable across renders that don't change `items` (the compute client reuses
// its indexed graph), so memo skips the expensive markdown re-render for
// unaffected rows.
export const ChatBlockView = observer(function ChatBlockView({
  block,
  index,
  highlighted,
  dimmed,
  sessionId,
  cwd,
  openFile,
  httpOrigin,
  onOpenImage,
  askLivePending,
  onAnswerAsk,
  answerInteractionId,
  collapseContext = false,
  compact = false,
  ctxSeq = null,
  stickyOperator = false,
  attribution,
  turn,
  process,
  arrived = false,
  onQuote,
  mailReply,
  markdownHtml,
}: {
  block: ChatBlock
  index: number
  highlighted: boolean
  dimmed: boolean
  sessionId: SessionId
  cwd: string
  openFile: (sessionId: SessionId, path: string) => void
  httpOrigin: string
  /** Open a full-screen image preview (lightbox) for the given asset URL. */
  onOpenImage: (src: string) => void
  /** True only for the latest unanswered AskUserQuestion on a live session. */
  askLivePending: boolean
  answerInteractionId?: string
  onAnswerAsk: (answer: import('./AskUserQuestionCard').AskUserQuestionAnswer) => Promise<void>
  /** Headless superagent sessions: collapse machine-authored [BTW/CONCIERGE
   *  CONTEXT/UPDATE] user blocks into a quiet disclosure row. */
  collapseContext?: boolean
  /** Superagent-column treatment: shared Flat Field messages at narrow-column
   * dimensions, with mono clocks, context labels, and an amber `→ next:` row. */
  compact?: boolean
  /** Issue seq the LATEST turn was answered with (compact only) — renders the
   *  `· POD-x context` suffix on that answer's SUPER AGENT label. */
  ctxSeq?: number | null
  /** True for an operator-authored row while the device-local sticky-prompt
   * preference is enabled. The row itself sticks; no duplicate header. */
  stickyOperator?: boolean
  /** The row's ACTOR + ON-BEHALF-OF pair (doc §3.1.3 A3), derived once per
   *  session by the chat slice and handed down. Passed in — never computed here
   *  — so the object identity stays stable across renders and this memoized
   *  component keeps skipping work. */
  attribution?: TranscriptAttribution
  /** This row's place in its exchange (POD-376) — see {@link TurnPosition}. */
  turn?: TurnPosition
  /** This row's place in the visible process narrative. */
  process?: ProcessPosition
  /** This row landed after the feed was already on screen (POD-423) — it plays
   *  its one-shot arrival. See `useFeedArrivals`. */
  arrived?: boolean
  /** Quote this message into the composer. Absent → no Quote action. */
  onQuote?: ((quote: QuoteInput) => void) | undefined
  mailReply?: MailReply | undefined
  /** Unsafe HTML produced off-thread; sanitation and link policy stay here. */
  markdownHtml?: ReadonlyMap<string, string>
}): JSX.Element | null {
  const { item } = block
  const message = useChatItemMessage(sessionId, item.role === 'user' ? item.id : undefined)
  const attachmentText = messageAttachmentText(item, message)
  const attachments = message?.attachments ?? []
  // Delivered-message envelope (#237) [spec:SP-34d7 web]: an inter-agent /
  // superagent / system message reaches the harness as a server-rendered frame
  // in a "user" turn — render it as a distinct framed block, never a "You"
  // bubble. Operator messages arrive unwrapped and fall through to the
  // ordinary user rendering (unwrapped = the human).
  const envelopeBatch = transcriptActivityFacts(item).envelopes
  // The agent's own mail (POD-2146), as the compute path read it: a send or
  // reply that went out is a note, an inbox read a quiet line. A mail call that
  // failed carries no `mail` and stays its tool row.
  const { mail } = block
  // Compact answers ending in a "→ next: …" line render it as a mono amber row
  // of its own (mock S1), not markdown prose.
  const nextSplit = useMemo(() => {
    if (!compact || item.role !== 'assistant' || !item.answer) return null
    const lines = item.text.trimEnd().split('\n')
    const last = lines[lines.length - 1]?.trim() ?? ''
    return /^(→|->)\s*next:/i.test(last)
      ? { body: lines.slice(0, -1).join('\n'), next: last.replace(/^->\s*/, '→ ') }
      : null
  }, [compact, item.role, item.answer, item.text])
  const displayText =
    envelopeBatch?.operatorText ||
    nextSplit?.body ||
    (item.role === 'user' ? codexQuestionReplyText(item.text) : undefined) ||
    attachmentText
  const refPrefixesVersion = useKnownRefPrefixesVersion()
  // biome-ignore lint/correctness/useExhaustiveDependencies: refPrefixesVersion is a deliberate recompute trigger — linkifyRefs reads the prefix registry.
  const html = useMemo(() => {
    // A summary can be many pages. Its disclosure renders markdown only on open.
    if (item.role === 'system' && item.systemKind === 'compaction') return ''
    const unsafeHtml = markdownHtml?.get(displayText)
    return unsafeHtml === undefined
      ? renderMarkdown(displayText)
      : sanitizeRenderedMarkdown(unsafeHtml)
    // Issue refs are state-free transcript content. Dynamic fleet state must
    // never become a dependency here: rewriting innerHTML killed selection and
    // shifted the feed on the issue-update cadence. The prefix REGISTRY is not
    // fleet state: it changes when a repo prefix appears, and a row rendered
    // before the registry arrived has no ref links until it re-renders
    // (POD-4966).
  }, [displayText, markdownHtml, refPrefixesVersion, item.role, item.systemKind])
  // Envelopes render as rows AHEAD of this block's own row (a provider turn can
  // deliver several frames before the operator's text), so when they exist they
  // are what opens the exchange and the body row binds to them.
  const hasEnvelopes = (envelopeBatch?.envelopes.length ?? 0) > 0
  const bodyTurnClass = turnClass(hasEnvelopes && turn === 'open' ? 'bind' : turn)
  // THE OPERATOR'S OWN TURN DOES NOT "ARRIVE" (POD-993 round 2). It was on
  // screen the instant they pressed send — the optimistic row in TranscriptFeed
  // played the card's entrance then — and this row is the same message coming
  // back off the wire to replace it. Animating it again makes the swap visible
  // as a second drop, which is the one thing the optimistic path exists to
  // avoid. Everything the reader did NOT put there keeps its arrival.
  const rowClass = cn(
    'group transcript-row isolate',
    bodyTurnClass,
    processClass(process),
    arrived && item.role !== 'user' && 'transcript-arrive',
    highlighted && 'transcript-search-hit',
    dimmed && 'opacity-35',
  )
  const nonStickyRowClass = cn(
    'transcript-row',
    processClass(process),
    arrived && 'transcript-arrive',
    highlighted && 'transcript-search-hit',
    dimmed && 'opacity-35',
  )

  // The concierge/btw seed & re-entry deltas are delivered as user text so the
  // agent sees them, but they're machine-authored context — collapse instead of
  // showing a giant "You" bubble (ported from the old SuperagentView renderer).
  if (collapseContext && item.role === 'user' && MACHINE_CONTEXT_RE.test(item.text))
    return <MachineContextRow item={item} cls={rowClass} index={index} />

  if (item.role === 'system' && item.systemKind === 'compaction')
    return (
      <CompactionNote
        item={item}
        cls={rowClass}
        index={index}
        highlighted={highlighted}
        sessionId={sessionId}
        cwd={cwd}
        openFile={openFile}
        markdownHtml={markdownHtml}
        onQuote={onQuote}
      />
    )

  if (isInterviewQuestion(item))
    return (
      <AskUserQuestionCard
        key={askLivePending ? `${item.id}:${answerInteractionId ?? ''}` : item.id}
        interactionId={askLivePending ? answerInteractionId : undefined}
        block={block}
        cls={rowClass}
        index={index}
        livePending={askLivePending}
        onAnswer={onAnswerAsk}
      />
    )
  // SendUserFile surfaces images/files to the user — render them inline (images as
  // clickable thumbnails → lightbox; other files as openable chips).
  if (item.role === 'tool' && item.toolName === 'SendUserFile')
    return (
      <SendUserFileBlock
        item={item}
        cls={rowClass}
        index={index}
        sessionId={sessionId}
        cwd={cwd}
        httpOrigin={httpOrigin}
        openFile={openFile}
        onOpenImage={onOpenImage}
      />
    )
  // Claude Code's while-you-were-gone recap (away_summary) — a distinct block.
  if (item.role === 'system' && item.systemKind === 'recap')
    return (
      <div className={rowClass} data-block={index} data-row-key={item.id}>
        <div className="transcript-rail transcript-rail--answer" aria-hidden="true" />
        <div className="transcript-body">
          <div className="transcript-header">
            <span className="transcript-role transcript-role--answer">Recap</span>
            <BlockClock ts={item.ts} />
          </div>
          <StableMarkdown html={html} sessionId={sessionId} cwd={cwd} openFile={openFile} />
        </div>
      </div>
    )
  // A turn's churn time (turn_duration) — a subtle "Churned for …" divider.
  if (item.role === 'system' && item.systemKind === 'duration')
    return (
      <div
        data-block={index}
        data-row-key={item.id}
        className={cn(
          rowClass,
          'my-1 flex items-center gap-2 text-[10px] tracking-[0.06em] text-muted-foreground/45 uppercase',
        )}
      >
        <span className="h-px flex-1 bg-border/60" />
        <span className="inline-flex items-center gap-1.5 px-0.5">
          <Clock size={11} aria-hidden="true" />
          <span>Churned for {formatChurn(item.durationMs ?? 0)}</span>
        </span>
        <span className="h-px flex-1 bg-border/60" />
      </div>
    )
  // A file the agent had read changed under it from outside its own tool calls
  // (POD-2179): one quiet line that opens the file.
  if (item.role === 'system' && item.systemKind === 'file-changed') {
    const path = item.toolPaths?.[0]
    const stamp = parseTs(item.ts)
    return (
      <div
        className={cn(nonStickyRowClass, turnClass(turn))}
        data-block={index}
        data-row-key={item.id}
        data-testid="file-changed"
      >
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div className="transcript-body">
          <div className="work-line">
            <button
              data-pressable
              type="button"
              className="file-change-row"
              title={path ? `Open ${path}` : undefined}
              disabled={!path}
              onClick={() => {
                if (path) openFile(sessionId, resolveMachinePath(cwd, path))
              }}
            >
              <FilePen size={13} strokeWidth={1.5} aria-hidden="true" />
              <span className="file-change-label">
                Changed on disk · {path ? machinePathBasename(path, cwd) : 'a file'}
              </span>
              {stamp && (
                <time className="file-change-time" dateTime={item.ts} title={fullTimeLabel(stamp)}>
                  · {clockLabel(stamp)}
                </time>
              )}
              <span className="file-change-rule" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    )
  }
  // A call that ADDRESSED THE HUMAN but carries no structured input to build a
  // card from (POD-376). Claude and Grok fill `toolInputJson` when they can;
  // on a Codex / MCP session this is every interview the agent ever ran — and
  // it used to render as a muted one-line tool row indistinguishable from a
  // file read, which is why the chat looked like it showed nothing at all while
  // the native view showed a prompt. It gets a named block of its own.
  if (item.role === 'tool' && isInteractiveTool(item)) {
    const planApproval = /(?:exit.*plan|plan.*approval|approve.*plan)/i.test(
      `${item.toolName ?? ''} ${item.toolTitle ?? ''}`,
    )
    return (
      <div className={rowClass} data-block={index} data-row-key={item.id} data-testid="asked-you">
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div className="transcript-body">
          <div className="asked-you" data-attention={planApproval ? 'plan' : 'question'}>
            <div className="asked-you-label">
              <MessageCircleQuestion size={11} aria-hidden="true" />
              {planApproval ? 'Plan ready · needs you' : 'Needs your input'}
              <span className="asked-you-tool">
                {item.toolName ? (mcpLabel(item.toolName) ?? item.toolName) : 'a question'}
              </span>
            </div>
            {(item.toolTitle ?? item.toolInput) && (
              <div className="asked-you-body">{item.toolTitle ?? item.toolInput}</div>
            )}
            <ToolBlock block={block} sessionId={sessionId} cwd={cwd} openFile={openFile} />
          </div>
        </div>
      </div>
    )
  }
  if (mail?.op === 'note')
    return (
      <SentNoteRow
        note={mail}
        fallbackId={item.id}
        className={cn(nonStickyRowClass, turnClass(turn))}
        blockIndex={index}
        ts={item.ts}
        onBodyClick={(e: ReactMouseEvent) => {
          handleChatMdClick(e, sessionId, cwd, openFile)
        }}
        forceOpen={highlighted}
      />
    )
  if (mail?.op === 'inbox')
    return (
      <InboxReadRow
        notes={mail.notes}
        result={block.result ?? item.toolResult}
        className={cn(nonStickyRowClass, turnClass(turn))}
        blockIndex={index}
        rowKey={item.id}
        ts={item.ts}
        forceOpen={highlighted}
      />
    )
  // Ordinary tool calls render inside a collapsed ToolBatchView, so they don't
  // reach here. Anything else stray shows as a lone quiet tool row.
  if (item.role === 'tool')
    return (
      <div className={rowClass} data-block={index} data-row-key={item.id}>
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div className="transcript-body py-0.5">
          <ToolBlock block={block} sessionId={sessionId} cwd={cwd} openFile={openFile} />
        </div>
      </div>
    )

  // A recognized user action that isn't a chat message (e.g. interrupt) is one
  // composed stop event. It stays neutral — the operator already caused it —
  // while an adjacent rejected tool keeps its own red actionable detail.
  if (item.event === 'interrupt') {
    return (
      <div
        data-block={index}
        data-row-key={item.id}
        data-event="interrupt"
        className={cn(rowClass, 'transcript-interrupt')}
      >
        <span className="transcript-interrupt-rule" />
        <span className="transcript-interrupt-stop" aria-hidden="true">
          □
        </span>
        <span>Interrupted by you</span>
        <BlockClock ts={item.ts} />
        <span className="transcript-interrupt-rule" />
      </div>
    )
  }

  // ONE BURST, ONE OBJECT (POD-993). A provider turn can deliver several frames
  // at once, and each used to take a row and a header of its own. They are one
  // folded line now — see MessageEnvelopeGroup for why mail reads better as mail.
  const envelopeRows = hasEnvelopes && envelopeBatch && (
    <MessageEnvelopeGroup
      envelopes={envelopeBatch.envelopes}
      className={cn(nonStickyRowClass, turnClass(turn))}
      blockIndex={envelopeBatch.operatorText === '' ? index : undefined}
      rowKey={envelopeBatch.operatorText === '' ? item.id : undefined}
      markdownHtml={markdownHtml}
      ts={item.ts}
      onBodyClick={(e: ReactMouseEvent) => {
        handleChatMdClick(e, sessionId, cwd, openFile)
      }}
      forceOpen={highlighted}
      mailReply={mailReply}
      onQuote={onQuote}
    />
  )

  // A delivered message from another principal is internal traffic, never a
  // "You" bubble. Any human follow-up in the same turn continues below as its
  // own prompt row.
  if (envelopeBatch && envelopeBatch.operatorText === '') return <>{envelopeRows}</>

  // Agent prose lies flat on the chassis; the operator's turn is the only
  // engraved surface. The final answer gets a quiet typographic step rather
  // than permanent signal colour — yellow is reserved for a request to act.
  const isUser = item.role === 'user'
  const isAnswer = item.role === 'assistant' && !!item.answer
  const quoteSource = quoteSourceLabel(isUser, item.ts)

  const turnBody = (
    <>
      <StableMarkdown html={html} sessionId={sessionId} cwd={cwd} openFile={openFile} />
      {nextSplit && <div className="chat-next">{nextSplit.next}</div>}
      {/* Attached media (POD-178): a turn's referenced files render as real
        inline previews — images as clickable thumbnails (→ lightbox), other
        files (artifacts, docs) as openable chips — instead of anonymous
        "image"/"file" tag chips. Tags without a resolvable path (older
        transcripts) keep the labelled chip. */}
      {((item.toolPaths?.length ?? 0) > 0 ||
        (item.tags?.length ?? 0) > 0 ||
        attachments.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-start gap-2">
          {(item.toolPaths ?? []).map((p) => {
            const abs = resolveMachinePath(cwd, p)
            const name = machinePathBasename(p, cwd)
            const chip = (
              <button
                data-pressable
                key={p}
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  openFile(sessionId, abs)
                }}
                className="inline-flex cursor-pointer items-center gap-1 rounded border border-input px-[7px] py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                title={`Open ${p}`}
              >
                <FileText size={12} aria-hidden="true" />
                {name}
              </button>
            )
            if (isImagePath(p))
              return (
                <ChatUploadThumb
                  key={p}
                  sessionId={sessionId}
                  attachmentId={stagedAttachmentId(abs)}
                  fallbackUrl={assetUrl({ httpOrigin, sessionId, fileDir: cwd, src: abs })}
                  name={name}
                  httpOrigin={httpOrigin}
                  onOpenImage={onOpenImage}
                  fallback={chip}
                />
              )
            return chip
          })}
          <ItemAttachments
            sessionId={sessionId}
            attachments={attachments.filter(
              (attachment) =>
                !attachment.id ||
                !item.toolPaths?.some((path) => stagedAttachmentId(path) === attachment.id),
            )}
            tags={(item.toolPaths?.length ?? 0) === 0 ? (item.tags ?? []) : []}
            httpOrigin={httpOrigin}
            onOpenImage={onOpenImage}
          />
        </div>
      )}
    </>
  )

  return (
    <>
      {envelopeRows}
      <div
        className={rowClass}
        data-block={index}
        data-row-key={item.id}
        data-operator-prompt={isUser ? 'true' : undefined}
        // The shelf's source set (POD-993). `data-operator-prompt` says "the
        // human spoke here"; this says "and it is a brief the pinned shelf may
        // carry" — which excludes interrupts, empty turns and machine-authored
        // context, and is off entirely when the preference is. See `usePinnedBrief`.
        data-pinnable={isUser && stickyOperator ? 'true' : undefined}
      >
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div
          className={cn(
            'transcript-body',
            item.role === 'assistant' && 'transcript-prose',
            isUser && 'transcript-you',
            isAnswer && 'transcript-answer',
          )}
          data-quote-source={quoteSource}
        >
          {item.role === 'system' && (
            <div className="transcript-header">
              <span className="transcript-role transcript-role--system">System</span>
            </div>
          )}
          {/* NO ANSWER EYEBROW IN THE STAGE (POD-2076). The answer stands out by
              ink alone — narration above it is muted and smaller. The narrow
              superagent dock keeps its voice label and context ref: there the
              answer shares a column with the thread's own chrome. */}
          {isAnswer && compact && (
            <div className="transcript-answer-label">
              Super agent
              {ctxSeq !== null && <span className="chat-ctx">· POD-{ctxSeq} context</span>}
            </div>
          )}
          {/* THE OPERATOR'S TURN IS A CHAT ENTRY (POD-993). It reads right, in
              its own tinted card, at a measure — because in a two-voice feed the
              side a message sits on is the fastest "who said this" there is, and
              it costs no label, no colour and no vertical space to say it. The
              agent keeps the full column and the flat ground: only the human's
              side is a card. Below the pane's own narrow threshold the card goes
              full width (see `.transcript-you` in styles.css) — at that width an
              indented bubble is a column of ragged offcuts. */}
          {isUser ? <PromptBubble>{turnBody}</PromptBubble> : turnBody}
          {/* Message controls follow the words in reading order. Activity
              members carry their own disclosures instead. */}
          <MessageActions
            text={displayText}
            onQuote={onQuote}
            quoteSource={quoteSource}
            ts={item.ts}
            side={isUser ? 'right' : 'left'}
          >
            {attribution && <AttributionMark attribution={attribution} />}
          </MessageActions>
        </div>
      </div>
    </>
  )
})
