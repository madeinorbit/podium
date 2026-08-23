import {
  formatChurn,
  isImagePath,
  isInteractiveTool,
  MACHINE_CONTEXT_RE,
  mcpLabel,
  parseEnvelopeBatch,
  type TranscriptAttribution,
} from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model/browser'
import { Clock, FileText, Image as ImageIcon, MessageCircleQuestion } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { assetUrl } from '@/lib/asset-url'
import { renderMarkdown, sanitizeRenderedMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { AttributionMark } from './AttributionMark'
import type { ChatBlock } from './chat'
import { handleChatMdClick } from './chat-md-click'
import { MachineContextRow } from './MachineContextRow'
import { MetaGlyph } from './MetaGlyph'
import { MessageEnvelopeGroup } from './MessageEnvelopeGroup'
import { SendUserFileBlock, SentImageThumb } from './SendUserFileBlock'
import { ToolBlock } from './ToolBlock'
import { clockLabel, fullTimeLabel, parseTs } from './transcript-time'

/** A row's place in its exchange (POD-376). `open` puts the air of a turn
 *  boundary in front of the row; `bind` pulls machine activity up under the
 *  prose that produced it. Absent → the feed's ordinary beat. The rule that
 *  decides which is which lives in TranscriptFeed, where the whole row sequence
 *  is visible. */
export type TurnPosition = 'open' | 'bind'

export function turnClass(turn: TurnPosition | undefined): string | undefined {
  return turn === 'open'
    ? 'transcript-turn-open'
    : turn === 'bind'
      ? 'transcript-turn-bind'
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
 * THE FOOT (POD-993). The actions used to be a floating chip over the top-right
 * corner of the message, and the time lived in an eyebrow above it — so a row's
 * metadata was in two places, one of them covering the first line of the words
 * it belonged to. They are one line now, in flow, directly UNDER the message and
 * hanging from the message's own edge: right under the human's card, left under
 * everything the machine says. Reading order gets what it wants (the words
 * first, their provenance after), and the two facts a reader wants about a
 * message — when, and take-a-copy — are in the same place for every voice.
 *
 * It is always present and always the same height, so nothing reflows when the
 * pointer crosses a row; what changes is ink, in two registers — see `.msg-foot`
 * in styles.css for why the clock and the buttons rest differently.
 */
function MessageActions({
  text,
  onQuote,
  ts,
  side,
  children,
}: {
  text: string
  onQuote?: ((markdown: string) => void) | undefined
  /** The row's own instant. Every voice now carries one here — see the foot's
   *  note below for why the clock left the label rows. */
  ts?: string | undefined
  /** Which edge the foot hangs from: the human's turn reads right, everything
   *  the machine says reads left, both directly under their own words. */
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
    onQuote?.(`${text.trim().replace(/^/gm, '> ')}\n\n`)
  }, [text, onQuote])
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
              title="Quote in composer"
              aria-label="Quote in composer"
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
const StableMarkdown = memo(function StableMarkdown({
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
    <div
      className={className}
      onClick={onClick}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify before this boundary
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

// Memoized: ChatView re-renders on every search keystroke, every 700ms
// transcript poll, and every session-state change in the store. Block identity
// is stable across renders that don't change `items` (the compute client reuses
// its indexed graph), so memo skips the expensive markdown re-render for
// unaffected rows.
export const ChatBlockView = memo(function ChatBlockView({
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
  collapseContext = false,
  compact = false,
  ctxSeq = null,
  stickyOperator = false,
  attribution,
  turn,
  arrived = false,
  onQuote,
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
  /** This row landed after the feed was already on screen (POD-423) — it plays
   *  its one-shot arrival. See `useFeedArrivals`. */
  arrived?: boolean
  /** Quote this message into the composer. Absent → no Quote action. */
  onQuote?: ((markdown: string) => void) | undefined
  /** Unsafe HTML produced off-thread; sanitation and link policy stay here. */
  markdownHtml?: ReadonlyMap<string, string>
}): JSX.Element | null {
  const { item } = block
  // Delivered-message envelope (#237) [spec:SP-34d7 web]: an inter-agent /
  // superagent / system message reaches the harness as a server-rendered frame
  // in a "user" turn — render it as a distinct framed block, never a "You"
  // bubble. Operator messages arrive unwrapped and fall through to the
  // ordinary user rendering (unwrapped = the human).
  const envelopeBatch = useMemo(
    () => (item.role === 'user' ? parseEnvelopeBatch(item.text) : null),
    [item.role, item.text],
  )
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
  const displayText = envelopeBatch?.operatorText || nextSplit?.body || item.text
  const html = useMemo(() => {
    const unsafeHtml = markdownHtml?.get(displayText)
    return unsafeHtml === undefined
      ? renderMarkdown(displayText)
      : sanitizeRenderedMarkdown(unsafeHtml)
    // Issue refs are state-free transcript content. Dynamic fleet state must
    // never become a dependency here: rewriting innerHTML killed selection and
    // shifted the feed on the issue-update cadence.
  }, [displayText, markdownHtml])
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
    arrived && item.role !== 'user' && 'transcript-arrive',
    highlighted && 'transcript-search-hit',
    dimmed && 'opacity-35',
  )
  const nonStickyRowClass = cn(
    'transcript-row',
    arrived && 'transcript-arrive',
    highlighted && 'transcript-search-hit',
    dimmed && 'opacity-35',
  )

  // The concierge/btw seed & re-entry deltas are delivered as user text so the
  // agent sees them, but they're machine-authored context — collapse instead of
  // showing a giant "You" bubble (ported from the old SuperagentView renderer).
  if (collapseContext && item.role === 'user' && MACHINE_CONTEXT_RE.test(item.text))
    return <MachineContextRow item={item} cls={rowClass} index={index} />

  if (item.role === 'tool' && item.toolName === 'AskUserQuestion' && item.toolInputJson)
    return (
      <AskUserQuestionCard
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
      <div className={rowClass} data-block={index}>
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
      <div className={rowClass} data-block={index} data-testid="asked-you">
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
  // Ordinary tool calls render inside a collapsed ToolBatchView, so they don't
  // reach here. Anything else stray shows as a lone quiet tool row.
  if (item.role === 'tool')
    return (
      <div className={rowClass} data-block={index}>
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
      markdownHtml={markdownHtml}
      ts={item.ts}
      onBodyClick={(e: ReactMouseEvent) => {
        handleChatMdClick(e, sessionId, cwd, openFile)
      }}
      forceOpen={highlighted}
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

  const turnBody = (
    <>
      <StableMarkdown html={html} sessionId={sessionId} cwd={cwd} openFile={openFile} />
      {nextSplit && <div className="chat-next">{nextSplit.next}</div>}
      {/* Attached media (POD-178): a turn's referenced files render as real
        inline previews — images as clickable thumbnails (→ lightbox), other
        files (artifacts, docs) as openable chips — instead of anonymous
        "image"/"file" tag chips. Tags without a resolvable path (older
        transcripts) keep the labelled chip. */}
      {((item.toolPaths?.length ?? 0) > 0 || (item.tags?.length ?? 0) > 0) && (
        <div className="mt-1.5 flex flex-wrap items-start gap-2">
          {(item.toolPaths ?? []).map((p) => {
            const abs = resolveAgainstCwd(cwd, p)
            const name = p.split('/').pop() ?? p
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
            if (isImagePath(p)) {
              const url = assetUrl({ httpOrigin, sessionId, fileDir: cwd, src: abs })
              if (url)
                return (
                  <SentImageThumb
                    key={p}
                    url={url}
                    name={name}
                    onOpen={() => onOpenImage(url)}
                    fallback={chip}
                  />
                )
            }
            return chip
          })}
          {(item.toolPaths?.length ?? 0) === 0 &&
            item.tags?.map((tag, i) => (
              <span
                key={`${tag.kind}-${i}`}
                className="inline-flex items-center gap-1 rounded border border-input px-[7px] py-0.5 text-[11px] text-muted-foreground"
              >
                {tag.kind === 'image' ? (
                  <ImageIcon size={12} aria-hidden="true" />
                ) : (
                  <FileText size={12} aria-hidden="true" />
                )}
                {tag.label ?? tag.kind}
              </span>
            ))}
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
            isUser && 'transcript-you',
            isAnswer && 'transcript-answer',
          )}
        >
          {item.role === 'system' && (
            <div className="transcript-header">
              <span className="transcript-role transcript-role--system">System</span>
            </div>
          )}
          {/* THE ONE SURVIVING IDENTIFIER (POD-993). Every other voice label is
              gone — the human's side says who they are, and narration needs no
              name — but the ANSWER is a different kind of row: it is where the
              turn lands, and a reader scanning back through a long session is
              looking for exactly this. It keeps its eyebrow; its time went to
              the foot with everyone else's. */}
          {isAnswer && (
            <div className="transcript-answer-label">
              {compact ? 'Super agent' : 'Answer'}
              {compact && ctxSeq !== null && (
                <span className="chat-ctx">· POD-{ctxSeq} context</span>
              )}
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
          {/* The foot: when, copy, quote — under the words, on the speaker's own
              side. Machine activity is excluded; a work line is a summary of
              rows that each have their own affordances. */}
          <MessageActions
            text={displayText}
            onQuote={onQuote}
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
