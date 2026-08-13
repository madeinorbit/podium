import {
  envelopePrincipal,
  formatChurn,
  isImagePath,
  isInteractiveTool,
  MACHINE_CONTEXT_RE,
  mcpLabel,
  type ParsedEnvelope,
  parseEnvelopeBatch,
  type TranscriptAttribution,
} from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model/browser'
import {
  Check,
  ChevronDown,
  Clock,
  Copy,
  FileText,
  Image as ImageIcon,
  Mail as MailIcon,
  MessageCircleQuestion,
  Quote,
} from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react'
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { assetUrl } from '@/lib/asset-url'
import { handleCodeCopyClick } from '@/lib/code-copy'
import { resolveAgainstCwd } from '@/lib/file-path'
import {
  type IssueReferenceLookup,
  isKnownRefPrefix,
  renderMarkdown,
  sanitizeRenderedMarkdown,
} from '@/lib/markdown'
import { activateRef } from '@/lib/ref-activation'
import { cn } from '@/lib/utils'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { AttributionMark } from './AttributionMark'
import type { ChatBlock } from './chat'
import { MachineContextRow } from './MachineContextRow'
import { SendUserFileBlock, SentImageThumb } from './SendUserFileBlock'
import { ToolBlock } from './ToolBlock'
import { clockLabel, fullTimeLabel, parseTs } from './transcript-time'

const EMPTY_ISSUE_REFERENCES: IssueReferenceLookup = new Map()

/** Shared chat-md click handling: code-copy buttons, ref-link chips (#474 —
 *  plain click opens the floating miniview, Cmd/Ctrl-click jumps to the full
 *  view), and file links. Used by the ordinary turn body AND the envelope
 *  block, so refs behave identically everywhere. */
function handleChatMdClick(
  e: ReactMouseEvent,
  sessionId: SessionId,
  cwd: string,
  openFile: (sessionId: SessionId, path: string) => void,
): void {
  if (handleCodeCopyClick(e)) return
  const refA = (e.target as HTMLElement).closest('a.ref-link') as HTMLElement | null
  if (refA) {
    const ref = refA.getAttribute('data-ref')
    if (ref) {
      e.preventDefault()
      activateRef(ref, e)
    }
    return
  }
  const a = (e.target as HTMLElement).closest('a.file-link') as HTMLElement | null
  if (!a) return
  e.preventDefault()
  const p = a.getAttribute('data-path')
  if (p) openFile(sessionId, resolveAgainstCwd(cwd, p))
}

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
 * pointer crosses a row. What changes is INK: dimmed at rest so the column stays
 * quiet under a long transcript, full on hover or keyboard focus of that row.
 * Rest is not invisible — the clock is information, and information the reader
 * has to hunt for with a mouse is information they do not have.
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
        <button
          data-pressable
          type="button"
          className="msg-action"
          onClick={copy}
          title="Copy message"
          aria-label={copied ? 'Message copied' : 'Copy message'}
        >
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        </button>
      )}
      {!empty && onQuote && (
        <button
          data-pressable
          type="button"
          className="msg-action"
          onClick={quote}
          title="Quote in composer"
          aria-label="Quote in composer"
        >
          <Quote size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

/** An envelope-header principal: the nice-id issue ref renders as the same
 *  clickable ref-link chip the markdown pass emits, so the sender/recipient
 *  are as navigable as refs in the body. Legacy `#seq` labels and sessions
 *  stay plain text. */
function PrincipalLabel({
  label,
  issueReferences,
}: {
  label: string
  issueReferences: IssueReferenceLookup
}): JSX.Element {
  const p = envelopePrincipal(label)
  const chip = p.ref !== null && isKnownRefPrefix(p.ref.split('-')[0] ?? '')
  return (
    <>
      {p.pre}
      {p.ref !== null &&
        (chip ? (
          <a
            className="ref-link ref-link--issue"
            href={`#${p.ref}`}
            data-ref={p.ref}
            data-issue-stage={issueReferences.get(p.ref)?.stage}
            data-issue-availability={issueReferences.get(p.ref)?.availability}
            aria-label={issueReferences.get(p.ref)?.accessibleLabel}
          >
            {p.ref}
          </a>
        ) : (
          p.ref
        ))}
      {p.post}
    </>
  )
}

function MessageEnvelopeRow({
  envelope,
  className,
  blockIndex,
  sessionId,
  cwd,
  openFile,
  issueReferences,
  markdownHtml,
  ts,
}: {
  envelope: ParsedEnvelope
  className: string
  blockIndex?: number
  sessionId: SessionId
  cwd: string
  openFile: (sessionId: SessionId, path: string) => void
  issueReferences: IssueReferenceLookup
  markdownHtml?: ReadonlyMap<string, string>
  ts?: string | undefined
}): JSX.Element {
  const html = useMemo(() => {
    const unsafeHtml = markdownHtml?.get(envelope.body)
    return unsafeHtml === undefined
      ? renderMarkdown(envelope.body, issueReferences)
      : sanitizeRenderedMarkdown(unsafeHtml, issueReferences)
  }, [envelope.body, issueReferences, markdownHtml])
  // FOLDED BY DEFAULT (POD-993). System mail is provenance: it explains why the
  // agent did what it did next, and a reader scanning a conversation should be
  // able to see that a message arrived, from whom, without the paragraph. So it
  // folds to one quiet mono line and opens on a click.
  //
  // Except when it is addressed AT the reader's attention: a frame that asks a
  // question or requests a reply is not background, and folding it would hide
  // the one kind of mail that has a consequence. Those open on arrival.
  const consequential = envelope.question || envelope.expectsReply
  const [open, setOpen] = useState(consequential)
  return (
    <div
      className={className}
      data-block={blockIndex}
      data-internal-message="true"
      data-testid="message-envelope"
    >
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: delegated clicks activate only semantic links emitted by sanitized markdown */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users activate those generated anchors natively */}
        <div
          className="message-envelope"
          data-open={open ? 'true' : 'false'}
          onClick={(e) => {
            handleChatMdClick(e, sessionId, cwd, openFile)
          }}
        >
          <div className="message-envelope-head">
            {/* The whole header line is the control: a fold whose hit target is
                a 12px chevron is a fold nobody uses. Refs inside the route stay
                clickable — they stop the toggle rather than the other way
                round, so a principal chip still opens its miniview. */}
            <button
              type="button"
              className="message-envelope-toggle"
              data-testid="message-envelope-toggle"
              aria-expanded={open}
              aria-label={open ? 'Fold this message' : 'Unfold this message'}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a')) return
                setOpen((v) => !v)
              }}
            >
              <span className="message-envelope-kind">
                <MailIcon size={11} aria-hidden="true" />
                Mail
              </span>
              <span aria-hidden="true" className="message-envelope-seam" />
              <span className="message-envelope-route">
                <PrincipalLabel label={envelope.from} issueReferences={issueReferences} />
                <span className="px-1.5 text-muted-foreground/40">→</span>
                <PrincipalLabel label={envelope.to} issueReferences={issueReferences} />
              </span>
              {envelope.question && <span className="message-envelope-badge">question</span>}
              {envelope.expectsReply && (
                <span className="message-envelope-badge message-envelope-badge--reply">
                  reply requested
                </span>
              )}
              <span className="message-envelope-meta">
                <BlockClock ts={ts} />
                {envelope.id}
                <ChevronDown className="message-envelope-chev" size={11} aria-hidden="true" />
              </span>
            </button>
          </div>
          {/* The fold is a grid row travelling 0fr → 1fr: the body keeps its
              natural height, nothing is measured in JS, and the rows below glide
              rather than jumping. */}
          <div className="message-envelope-fold" aria-hidden={!open}>
            <div className="message-envelope-fold-inner">
              <div
                className="chat-md message-envelope-body"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify in renderMarkdown
                dangerouslySetInnerHTML={{ __html: html }}
              />
              {envelope.machineNote && (
                <div className="message-envelope-note">{envelope.machineNote}</div>
              )}
            </div>
          </div>
        </div>
      </div>
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
 * THE BRIEF IS CUT ONLY WHILE IT IS PINNED (POD-993).
 *
 * Two earlier readings of this are both preserved in the design, because the new
 * rule is the seam between them. POD-747 removed a clamp that fired on EVERY
 * collapsed brief — a two-line message arriving pre-truncated behind a "Read
 * more" for the four words it was hiding — and it was right: in the flow of the
 * document a brief is the one thing the reader wrote themselves, and hiding part
 * of it to buy space in their own conversation is not a trade. What POD-747 then
 * had to do about a pasted forty-line spec was refuse it the pin, so the context
 * shelf simply vanished for the exchanges that needed it most.
 *
 * The rule now separates the two states the row actually has. IN FLOW the brief
 * is never cut — every word, no fade, no control, exactly as POD-747 left it.
 * PINNED it is a shelf rather than a message, and a shelf has a height: it
 * clamps to `--prompt-pin-clamp`, fades at its own bottom edge and offers one
 * toggle to open it in place. Nothing is hidden at the moment the reader is
 * reading it — the clamp engages only once the row has scrolled to the top edge
 * and become chrome, and it releases the moment they scroll back to it.
 */
function PromptBubble({
  bodyRef,
  clamped,
  open,
  onToggle,
  children,
}: {
  bodyRef: RefObject<HTMLDivElement | null>
  /** The pinned shelf is taller than the clamp — the reader is owed a control. */
  clamped: boolean
  open: boolean
  onToggle: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <div className="transcript-you-bubble" data-pin-open={open ? 'true' : undefined}>
        <div className="transcript-you-body" ref={bodyRef}>
          {children}
        </div>
        {clamped && (
          <button
            data-pressable
            type="button"
            className="prompt-expand"
            data-testid="prompt-expand-toggle"
            aria-expanded={open}
            onClick={onToggle}
          >
          {open ? 'Collapse brief' : 'Show full brief'}
        </button>
      )}
    </div>
  )
}

/** The clamp the pinned shelf takes, in px — kept in step with
 *  `--prompt-pin-clamp` in styles.css, which is what actually cuts. Roughly four
 *  lines of the brief's own 13.5/1.6 setting: enough for the whole of an
 *  ordinary message, short enough that a pasted spec cannot become a lid. */
const PIN_CLAMP_PX = 92

/**
 * Whether a pinned brief is tall enough for the clamp to bite — i.e. whether the
 * reader is owed a control to open it again.
 *
 * Measured on the body itself rather than guessed from character count, because
 * what matters is rendered height at this pane width: the same text is two lines
 * in a full-width stage and six in a split pane. Re-measured through a
 * ResizeObserver so dragging the pane narrower grows the control into existence
 * rather than leaving a silently cut shelf.
 */
function useClamps(enabled: boolean, ref: RefObject<HTMLElement | null>): boolean {
  const [clamps, setClamps] = useState(false)
  useLayoutEffect(() => {
    if (!enabled) {
      setClamps(false)
      return
    }
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      setClamps(el.scrollHeight > PIN_CLAMP_PX + 4)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  })
  return clamps
}

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
  issueReferences = EMPTY_ISSUE_REFERENCES,
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
  issueReferences?: IssueReferenceLookup
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
      ? renderMarkdown(displayText, issueReferences)
      : sanitizeRenderedMarkdown(unsafeHtml, issueReferences)
  }, [displayText, issueReferences, markdownHtml])
  // Envelopes render as rows AHEAD of this block's own row (a provider turn can
  // deliver several frames before the operator's text), so when they exist they
  // are what opens the exchange and the body row binds to them.
  const hasEnvelopes = (envelopeBatch?.envelopes.length ?? 0) > 0
  const bodyTurnClass = turnClass(hasEnvelopes && turn === 'open' ? 'bind' : turn)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const promptBodyRef = useRef<HTMLDivElement | null>(null)
  // Every operator brief takes the pin now (POD-993). It used to yield the pin
  // above half the viewport, because a long brief pinned at full height is a lid
  // over the answer; the clamp below is the better answer to that, and it keeps
  // the context shelf for exactly the exchanges that most need one.
  const pinned = stickyOperator
  const [pinOpen, setPinOpen] = useState(false)
  const clamps = useClamps(pinned, promptBodyRef)
  const rowClass = cn(
    'group transcript-row isolate',
    bodyTurnClass,
    pinned &&
      'sticky -top-6 z-[3] transition-[box-shadow] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
    arrived && 'transcript-arrive',
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
          <div
            className="chat-md"
            onClick={(e) => {
              handleChatMdClick(e, sessionId, cwd, openFile)
            }}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
            dangerouslySetInnerHTML={{ __html: html }}
          />
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

  const envelopeRows = envelopeBatch?.envelopes.map((envelope, envelopeIndex) => (
    <MessageEnvelopeRow
      key={envelope.id}
      envelope={envelope}
      className={cn(
        nonStickyRowClass,
        // Delivered mail arrives as one exchange: the first frame takes the
        // turn's air, the rest stack under it.
        turnClass(envelopeIndex === 0 ? turn : 'bind'),
      )}
      blockIndex={envelopeBatch.operatorText === '' && envelopeIndex === 0 ? index : undefined}
      sessionId={sessionId}
      cwd={cwd}
      openFile={openFile}
      issueReferences={issueReferences}
      markdownHtml={markdownHtml}
      ts={item.ts}
    />
  ))

  // A delivered message from another principal is internal traffic, never a
  // "You" bubble and never sticky. Multiple leading frames may share one
  // provider turn; any human follow-up continues below as its own prompt row.
  if (envelopeBatch && envelopeBatch.operatorText === '') return <>{envelopeRows}</>

  // Agent prose lies flat on the chassis; the operator's turn is the only
  // engraved surface. The final answer gets a quiet typographic step rather
  // than permanent signal colour — yellow is reserved for a request to act.
  const isUser = item.role === 'user'
  const isAnswer = item.role === 'assistant' && !!item.answer

  const turnBody = (
    <>
      <div
        className="chat-md"
        onClick={(e) => {
          handleChatMdClick(e, sessionId, cwd, openFile)
        }}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
        dangerouslySetInnerHTML={{ __html: html }}
      />
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
        ref={rowRef}
        className={rowClass}
        data-block={index}
        data-operator-prompt={isUser ? 'true' : undefined}
      >
        {pinned && (
          <div
            // The sheet, not the app background (POD-725): the stage is a card
            // now, and the brief lost its own panel — so this backdrop is the
            // only thing occluding the transcript that scrolls under a pinned
            // prompt, and it has to be the exact tone it is pinned against.
            className="pointer-events-none absolute inset-y-0 left-1/2 -z-10 w-screen -translate-x-1/2 bg-card/90 opacity-0 backdrop-blur-sm transition-opacity duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[stuck=true]:opacity-100 motion-reduce:transition-none"
            data-sticky-prompt-backdrop
            aria-hidden="true"
          />
        )}
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
          {isUser ? (
            <PromptBubble
              bodyRef={promptBodyRef}
              clamped={pinned && clamps}
              open={pinOpen}
              onToggle={() => {
                setPinOpen((v) => !v)
              }}
            >
              {turnBody}
            </PromptBubble>
          ) : (
            turnBody
          )}
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
