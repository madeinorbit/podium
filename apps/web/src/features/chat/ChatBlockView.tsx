import { formatChurn, isImagePath, MACHINE_CONTEXT_RE } from '@podium/client-core/viewmodels'
import { Clock, FileText, Image as ImageIcon, Mail as MailIcon } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { memo, useMemo } from 'react'
import { assetUrl } from '@/lib/asset-url'
import { handleCodeCopyClick } from '@/lib/code-copy'
import { resolveAgainstCwd } from '@/lib/file-path'
import { isKnownRefPrefix, renderMarkdown } from '@/lib/markdown'
import { activateRef } from '@/lib/ref-activation'
import { cn } from '@/lib/utils'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import type { ChatBlock } from './chat'
import { MachineContextRow } from './MachineContextRow'
import { envelopePrincipal, parseEnvelopeBatch, type ParsedEnvelope } from './message-envelope'
import { SendUserFileBlock, SentImageThumb } from './SendUserFileBlock'
import { ToolBlock } from './ToolBlock'

/** Shared chat-md click handling: code-copy buttons, ref-link chips (#474 —
 *  plain click opens the floating miniview, Cmd/Ctrl-click jumps to the full
 *  view), and file links. Used by the ordinary turn body AND the envelope
 *  block, so refs behave identically everywhere. */
function handleChatMdClick(
  e: ReactMouseEvent,
  sessionId: string,
  cwd: string,
  openFile: (sessionId: string, path: string) => void,
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

/** An envelope-header principal: the nice-id issue ref renders as the same
 *  clickable ref-link chip the markdown pass emits, so the sender/recipient
 *  are as navigable as refs in the body. Legacy `#seq` labels and sessions
 *  stay plain text. */
function PrincipalLabel({ label }: { label: string }): JSX.Element {
  const p = envelopePrincipal(label)
  const chip = p.ref !== null && isKnownRefPrefix(p.ref.split('-')[0] ?? '')
  return (
    <>
      {p.pre}
      {p.ref !== null &&
        (chip ? (
          // biome-ignore lint/a11y/useValidAnchor: in-window chip like the markdown-emitted ref links — navigation is store-driven, there is no URL to href
          <a className="ref-link ref-link--issue" data-ref={p.ref}>
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
}: {
  envelope: ParsedEnvelope
  className: string
  blockIndex?: number
  sessionId: string
  cwd: string
  openFile: (sessionId: string, path: string) => void
}): JSX.Element {
  const html = useMemo(() => renderMarkdown(envelope.body), [envelope.body])
  return (
    <div
      className={className}
      data-block={blockIndex}
      data-internal-message="true"
      data-testid="message-envelope"
    >
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body">
        <div
          className="relative overflow-hidden rounded-r-lg border border-border/70 border-l-0 bg-muted/20 px-3.5 py-2.5 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-info/70"
          onClick={(e) => {
            handleChatMdClick(e, sessionId, cwd, openFile)
          }}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[9px] tracking-[0.11em] text-muted-foreground/70 uppercase">
            <span className="inline-flex items-center gap-1.5 font-semibold text-info">
              <MailIcon size={11} aria-hidden="true" />
              Internal
            </span>
            <span aria-hidden="true" className="h-3 w-px bg-border" />
            <span className="tracking-normal text-muted-foreground normal-case">
              <PrincipalLabel label={envelope.from} />
              <span className="px-1.5 text-muted-foreground/40">→</span>
              <PrincipalLabel label={envelope.to} />
            </span>
            {envelope.question && (
              <span className="rounded-sm bg-amber-500/10 px-1.5 py-0.5 font-semibold text-[8px] tracking-wide text-amber-600 dark:text-amber-400">
                question
              </span>
            )}
            {envelope.expectsReply && (
              <span className="rounded-sm bg-info/10 px-1.5 py-0.5 font-semibold text-[8px] tracking-wide text-info">
                reply requested
              </span>
            )}
            <span className="ml-auto tracking-normal text-muted-foreground/45 normal-case">
              {envelope.id}
            </span>
          </div>
          <div
            className="chat-md mt-2 border-border/50 border-t pt-2 text-[13px] text-foreground/85"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify in renderMarkdown
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {envelope.machineNote && (
            <div className="mt-2 border-border/50 border-t pt-1.5 font-mono text-[9px] text-muted-foreground/55">
              {envelope.machineNote}
            </div>
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
}: {
  block: ChatBlock
  index: number
  highlighted: boolean
  dimmed: boolean
  sessionId: string
  cwd: string
  openFile: (sessionId: string, path: string) => void
  httpOrigin: string
  /** Open a full-screen image preview (lightbox) for the given asset URL. */
  onOpenImage: (src: string) => void
  /** True only for the latest unanswered AskUserQuestion on a live session. */
  askLivePending: boolean
  onAnswerAsk: (choices: { optionIndices: number[] }[]) => Promise<void>
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
  const html = useMemo(() => renderMarkdown(displayText), [displayText])
  const rowClass = cn(
    'transcript-row mx-auto w-full max-w-[960px]',
    stickyOperator &&
      'sticky -top-6 z-[3] transition-[background-color,box-shadow] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] data-[stuck=true]:bg-background/90 data-[stuck=true]:backdrop-blur-sm motion-reduce:transition-none',
    highlighted && 'rounded-md outline outline-1 outline-primary outline-offset-4',
    dimmed && 'opacity-35',
  )
  const nonStickyRowClass = cn(
    'transcript-row mx-auto w-full max-w-[960px]',
    highlighted && 'rounded-md outline outline-1 outline-primary outline-offset-4',
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
  // Ordinary tool calls render inside a collapsed ToolBatchView, so they don't
  // reach here. The only stray case is an AskUserQuestion without structured input
  // (no card) — show it as a lone quiet tool row so it isn't dropped.
  if (item.role === 'tool')
    return (
      <div className={rowClass} data-block={index}>
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div className="transcript-body py-0.5">
          <ToolBlock block={block} sessionId={sessionId} cwd={cwd} openFile={openFile} />
        </div>
      </div>
    )

  // A recognized user action that isn't a chat message (e.g. interrupt) — show it
  // as a thin inline divider, not a "You" bubble.
  if (item.event === 'interrupt') {
    return (
      <div
        data-block={index}
        className={cn(
          rowClass,
          'my-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.07em] text-muted-foreground/55',
        )}
      >
        <span className="h-px flex-1 bg-border" />
        Interrupted
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }

  const envelopeRows = envelopeBatch?.envelopes.map((envelope, envelopeIndex) => (
    <MessageEnvelopeRow
      key={envelope.id}
      envelope={envelope}
      className={nonStickyRowClass}
      blockIndex={envelopeBatch.operatorText === '' && envelopeIndex === 0 ? index : undefined}
      sessionId={sessionId}
      cwd={cwd}
      openFile={openFile}
    />
  ))

  // A delivered message from another principal is internal traffic, never a
  // "You" bubble and never sticky. Multiple leading frames may share one
  // provider turn; any human follow-up continues below as its own prompt row.
  if (envelopeBatch && envelopeBatch.operatorText === '') return <>{envelopeRows}</>

  // Flat Field (POD-159): agent prose lies flat on the chassis; the operator's
  // turn is the only elevated (embossed) surface; the final answer is marked by
  // the field's single yellow keyline rather than a box.
  const isUser = item.role === 'user'
  const isAnswer = item.role === 'assistant' && !!item.answer

  return (
    <>
      {envelopeRows}
      <div
        className={rowClass}
        data-block={index}
        data-operator-prompt={isUser ? 'true' : undefined}
      >
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div
          className={cn(
            'transcript-body',
            isUser && 'transcript-you',
            isAnswer && 'transcript-answer',
          )}
        >
          {isUser && (
            <div className="transcript-you-label">
              You
              {compact && <BlockClock ts={item.ts} />}
            </div>
          )}
          {item.role === 'system' && (
            <div className="transcript-header">
              <span className="transcript-role transcript-role--system">System</span>
            </div>
          )}
          {isAnswer && (
            <div className="transcript-answer-label">
              {compact ? 'Super agent' : 'Answer'}
              {compact && ctxSeq !== null && (
                <span className="chat-ctx">· POD-{ctxSeq} context</span>
              )}
              {compact && <BlockClock ts={item.ts} />}
            </div>
          )}
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
        </div>
      </div>
    </>
  )
})
