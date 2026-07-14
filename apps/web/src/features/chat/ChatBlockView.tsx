import { formatChurn, MACHINE_CONTEXT_RE } from '@podium/client-core/viewmodels'
import { Clock, FileText, Image as ImageIcon, Mail as MailIcon } from 'lucide-react'
import type { JSX } from 'react'
import { memo, useMemo } from 'react'
import { handleCodeCopyClick } from '@/lib/code-copy'
import { resolveAgainstCwd } from '@/lib/file-path'
import { renderMarkdown } from '@/lib/markdown'
import { activateRef } from '@/lib/ref-activation'
import { cn } from '@/lib/utils'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import type { ChatBlock } from './chat'
import { MachineContextRow } from './MachineContextRow'
import { envelopePrincipalLabel, parseMessageEnvelope } from './message-envelope'
import { SendUserFileBlock } from './SendUserFileBlock'
import { ToolBlock } from './ToolBlock'

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
}): JSX.Element | null {
  const { item } = block
  // Delivered-message envelope (#237) [spec:SP-34d7 web]: an inter-agent /
  // superagent / system message reaches the harness as a server-rendered frame
  // in a "user" turn — render it as a distinct framed block, never a "You"
  // bubble. Operator messages arrive unwrapped and fall through to the
  // ordinary user rendering (unwrapped = the human).
  const envelope = useMemo(
    () => (item.role === 'user' ? parseMessageEnvelope(item.text) : null),
    [item.role, item.text],
  )
  const html = useMemo(
    () => renderMarkdown(envelope ? envelope.body : item.text),
    [envelope, item.text],
  )
  const rowClass = cn(
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
        <Clock size={11} aria-hidden="true" /> Churned for {formatChurn(item.durationMs ?? 0)}
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

  // A delivered message from another principal — a distinct framed block, not
  // a "You" bubble (#237) [spec:SP-34d7 web]. Sender, message id, question
  // marker; the body is the sanitized text the agent actually received.
  if (envelope)
    return (
      <div className={rowClass} data-block={index} data-testid="message-envelope">
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div className="transcript-body">
          <div className="rounded-md border border-info/40 bg-info/5 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
              <MailIcon size={12} className="self-center text-info" aria-hidden="true" />
              <span className="font-medium text-info">{envelopePrincipalLabel(envelope.from)}</span>
              <span className="text-muted-foreground/70">
                → {envelopePrincipalLabel(envelope.to)}
              </span>
              {envelope.question && (
                <span className="rounded border border-amber-500/50 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  question
                </span>
              )}
              <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
                {envelope.id}
              </span>
            </div>
            <div
              className="chat-md mt-1"
              onClick={(e) => {
                handleCodeCopyClick(e)
              }}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </div>
      </div>
    )

  // Rail: user → blue accent, final answer → primary/amber, everything else → none
  const hasUserRail = item.role === 'user'
  const hasAnswerRail = item.role === 'assistant' && !!item.answer
  const hasRail = hasUserRail || hasAnswerRail

  return (
    <div className={rowClass} data-block={index}>
      {hasRail ? (
        <div
          className={cn(
            'transcript-rail',
            hasUserRail && 'transcript-rail--user',
            hasAnswerRail && 'transcript-rail--answer',
          )}
          aria-hidden="true"
        />
      ) : (
        // No rail: spacer so body lines up with railed rows
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      )}
      <div className="transcript-body">
        {item.role === 'user' && (
          <div className="transcript-header">
            <span className="transcript-role">You</span>
          </div>
        )}
        {item.role === 'system' && (
          <div className="transcript-header">
            <span className="transcript-role transcript-role--system">System</span>
          </div>
        )}
        {item.role === 'assistant' && item.answer && (
          <div className="transcript-header">
            <span className="transcript-role transcript-role--answer">Answer</span>
          </div>
        )}
        <div
          className="chat-md"
          onClick={(e) => {
            if (handleCodeCopyClick(e)) return
            // Human-facing ref links (#474): plain click opens the floating
            // miniview, Cmd/Ctrl-click jumps to the full issue/session view.
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
          }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {item.tags && item.tags.length > 0 && (
          <div className="mt-1.5 flex gap-1.5">
            {item.tags.map((tag, i) => {
              const filePath =
                tag.kind === 'file' && item.toolPaths?.[0]
                  ? resolveAgainstCwd(cwd, item.toolPaths[0])
                  : null
              return filePath ? (
                <button
                  key={`${tag.kind}-${i}`}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    openFile(sessionId, filePath)
                  }}
                  className="inline-flex cursor-pointer items-center gap-1 rounded border border-input px-[7px] py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={`Open ${filePath}`}
                >
                  <FileText size={12} aria-hidden="true" />
                  {tag.label ?? tag.kind}
                </button>
              ) : (
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
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
})
