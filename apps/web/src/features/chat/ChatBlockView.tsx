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
import type { SessionId } from '@podium/model'
import {
  Check,
  Clock,
  Copy,
  FileText,
  Image as ImageIcon,
  Mail as MailIcon,
  MessageCircleQuestion,
  Quote,
} from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { assetUrl } from '@/lib/asset-url'
import { handleCodeCopyClick } from '@/lib/code-copy'
import { resolveAgainstCwd } from '@/lib/file-path'
import { type IssueReferenceLookup, isKnownRefPrefix, renderMarkdown } from '@/lib/markdown'
import { activateRef } from '@/lib/ref-activation'
import { cn } from '@/lib/utils'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { AttributionMark } from './AttributionMark'
import type { ChatBlock } from './chat'
import { MachineContextRow } from './MachineContextRow'
import { SendUserFileBlock, SentImageThumb } from './SendUserFileBlock'
import { ToolBlock } from './ToolBlock'

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
 * The group is ABSOLUTELY positioned and only fades in, so a row never changes
 * height or reflows when the pointer crosses it — a feed that twitches under
 * the cursor is worse than one with no actions at all. It stays in the tab
 * order and reveals itself on focus, so the keyboard route is the same route.
 */
function MessageActions({
  text,
  onQuote,
}: {
  text: string
  onQuote?: ((markdown: string) => void) | undefined
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
  if (!text.trim()) return null
  return (
    <div className="msg-actions" data-testid="message-actions">
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
      {onQuote && (
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
          // biome-ignore lint/a11y/useValidAnchor: in-window chip like the markdown-emitted ref links — navigation is store-driven, there is no URL to href
          <a
            className="ref-link ref-link--issue"
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
  ts,
}: {
  envelope: ParsedEnvelope
  className: string
  blockIndex?: number
  sessionId: SessionId
  cwd: string
  openFile: (sessionId: SessionId, path: string) => void
  issueReferences: IssueReferenceLookup
  ts?: string | undefined
}): JSX.Element {
  const html = useMemo(
    () => renderMarkdown(envelope.body, issueReferences),
    [envelope.body, issueReferences],
  )
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
          onClick={(e) => {
            handleChatMdClick(e, sessionId, cwd, openFile)
          }}
        >
          <div className="message-envelope-head">
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
            </span>
          </div>
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
  )
}

/** Right-aligned mono clock on compact role labels (mock S1). Absent ts → no row. */
function BlockClock({ ts }: { ts?: string | undefined }): JSX.Element | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return (
    <span className="chat-clk">
      {String(d.getHours()).padStart(2, '0')}:{String(d.getMinutes()).padStart(2, '0')}
    </span>
  )
}

/** scrollHeight/clientHeight are integers rounded from fractional layout, so a
 *  message that fits perfectly still reports a pixel or two of "overflow"
 *  (measured: 24 vs 22 for a single 21.59px line). That rounding is the ONLY
 *  thing this slack is allowed to absorb.
 *
 *  It used to be 8px, which is most of a line — and the fade rendered whether
 *  or not the toggle did, so a prompt measuring 45px of content in a 43px box
 *  got its last line greyed out with no way to expand it (POD-376). Two changes
 *  fix that class of bug rather than that instance: the slack now covers only
 *  rounding, and the fade is drawn by `data-cut`, which is set from the SAME
 *  verdict that renders the toggle. The cut and the way out of it cannot
 *  disagree again. */
const PROMPT_OVERFLOW_SLACK_PX = 4

/** A sticky operator prompt is pinned over the very transcript it belongs to,
 *  so a long message would blanket the whole feed (POD-1368). Cap the prompt
 *  body at a fraction of the chat viewport (`--chat-viewport-h`, published by
 *  the scroller; the height math lives in `.transcript-you-clamp`) and offer a
 *  "Read more" toggle when there is anything hidden. Clamping applies in normal
 *  flow too, so the row's height never changes as it sticks and unsticks —
 *  that would jitter the content below it at the stick boundary.
 *
 *  The toggle rides in the YOU label row rather than under the text: an
 *  expanded prompt is taller than the viewport, so a control below the message
 *  would scroll out of reach exactly when the reader wants to collapse it
 *  again. The label row is the one part of a stuck prompt always on screen. */
function ClampedPromptBody({
  label,
  forceOpen,
  children,
}: {
  label: ReactNode
  /** The active search match — the clamp yields, because a hit the reader
   *  cannot see is worse than a prompt that briefly takes the whole column. */
  forceOpen: boolean
  children: ReactNode
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const clamped = !expanded && !forceOpen

  // Measure after every render (markdown height changes with content and with
  // column width) and whenever the clamp box or its content resizes — late
  // image/code layout settles after paint. While expanded the clamp is off and
  // the comparison is vacuous, so the last clamped verdict is kept: the control
  // must not vanish out from under the reader who just used it.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      if (el.dataset.clamped !== 'true') return
      setOverflowing(el.scrollHeight - el.clientHeight > PROMPT_OVERFLOW_SLACK_PX)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => ro.disconnect()
  })

  return (
    <>
      <div className="transcript-you-label">
        {label}
        {overflowing && !forceOpen && (
          <button
            data-pressable
            type="button"
            data-testid="prompt-expand-toggle"
            className="transcript-you-more"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : 'Read more'}
          </button>
        )}
      </div>
      <div
        className="transcript-you-clamp"
        data-clamped={clamped ? 'true' : undefined}
        // The fade + ellipsis, drawn only where something is genuinely hidden —
        // and therefore only where the toggle above offers a way to see it.
        data-cut={clamped && overflowing ? 'true' : undefined}
        ref={ref}
      >
        {children}
      </div>
    </>
  )
}

// Memoized: ChatView re-renders on every search keystroke, every 700ms
// transcript poll, and every session-state change in the store. Block identity
// is stable across renders that don't change `items` (pairToolResults is
// memoized), so memo skips the expensive markdown re-render for unaffected rows.
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
  const html = useMemo(
    () => renderMarkdown(displayText, issueReferences),
    [displayText, issueReferences],
  )
  // Envelopes render as rows AHEAD of this block's own row (a provider turn can
  // deliver several frames before the operator's text), so when they exist they
  // are what opens the exchange and the body row binds to them.
  const hasEnvelopes = (envelopeBatch?.envelopes.length ?? 0) > 0
  const bodyTurnClass = turnClass(hasEnvelopes && turn === 'open' ? 'bind' : turn)
  const rowClass = cn(
    'group transcript-row isolate mx-auto w-full max-w-[960px]',
    bodyTurnClass,
    stickyOperator &&
      'sticky -top-6 z-[3] transition-[box-shadow] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
    arrived && 'transcript-arrive',
    highlighted && 'transcript-search-hit',
    dimmed && 'opacity-35',
  )
  const nonStickyRowClass = cn(
    'transcript-row mx-auto w-full max-w-[960px]',
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
          </div>
          <div
            className="chat-md"
            onClick={(e) => {
              handleCodeCopyClick(e)
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
  // card from (POD-376). Only the Claude parser fills `toolInputJson`, so on a
  // Codex / Grok / MCP session this is every interview the agent ever ran — and
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
        className={rowClass}
        data-block={index}
        data-operator-prompt={isUser ? 'true' : undefined}
      >
        {stickyOperator && (
          <div
            className="pointer-events-none absolute inset-y-0 left-1/2 -z-10 w-screen -translate-x-1/2 bg-background/90 opacity-0 backdrop-blur-sm transition-opacity duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[stuck=true]:opacity-100 motion-reduce:transition-none"
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
          {/* Copy / quote, on every row that carries a message a reader might
              want to take with them. Machine activity is excluded — a work line
              is a summary of rows that each have their own affordances. */}
          <MessageActions text={displayText} onQuote={onQuote} />
          {isUser && !stickyOperator && (
            <div className="transcript-you-label">
              You
              {attribution && <AttributionMark attribution={attribution} />}
              {compact && <BlockClock ts={item.ts} />}
            </div>
          )}
          {item.role === 'system' && (
            <div className="transcript-header">
              <span className="transcript-role transcript-role--system">System</span>
              {attribution && <AttributionMark attribution={attribution} />}
            </div>
          )}
          {isAnswer && (
            <div className="transcript-answer-label">
              {compact ? 'Super agent' : 'Answer'}
              {attribution && <AttributionMark attribution={attribution} />}
              {compact && ctxSeq !== null && (
                <span className="chat-ctx">· POD-{ctxSeq} context</span>
              )}
              {compact && <BlockClock ts={item.ts} />}
            </div>
          )}
          {isUser && stickyOperator ? (
            <ClampedPromptBody
              forceOpen={highlighted}
              label={
                <>
                  Your brief · active turn
                  {/* Same label content as the non-sticky YOU row above — the
                      clamp (POD-1368) only changes WHERE the label renders, so
                      the attribution mark (doc §3.1.3 A3) rides along. */}
                  {attribution && <AttributionMark attribution={attribution} />}
                  {compact && <BlockClock ts={item.ts} />}
                </>
              }
            >
              {turnBody}
            </ClampedPromptBody>
          ) : (
            turnBody
          )}
        </div>
      </div>
    </>
  )
})
