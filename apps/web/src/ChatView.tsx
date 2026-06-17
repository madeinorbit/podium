import type { TranscriptItem } from '@podium/protocol'
import {
  ArrowDownToLine,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  FileText,
  Image as ImageIcon,
  Mic,
  Paperclip,
} from 'lucide-react'
import type { JSX } from 'react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  blockMatches,
  type ChatBlock,
  minimapSegments,
  pairToolResults,
  type PendingItem,
  reconcilePending,
  searchBlocks,
} from './chat'
import { chatActivity } from './derive'
import { renderMarkdown } from './markdown'
import { useStore } from './store'
import { useVoiceInput } from './voice'

/**
 * Claude-app-style chat rendering of a session's structured transcript, with a
 * native write-through input, quick transcript search, and a Sublime-style
 * birds-eye minimap (user prompts highlighted; click scrolls).
 */
export function ChatView({ sessionId }: { sessionId: string }): JSX.Element {
  const { hub, trpc, sessions, drafts, setSessionDraft, resumeAndSend } = useStore()
  const session = sessions.find((s) => s.sessionId === sessionId)
  const [items, setItems] = useState<TranscriptItem[]>([])
  // A parked session (hibernated/exited) has no live tail and an empty server
  // buffer after a restart, so the stream stays empty. Read its history off disk
  // on demand instead. Prefer it only when the live buffer is empty (a session
  // parked within this server's lifetime still has its buffer).
  const [fetched, setFetched] = useState<TranscriptItem[] | null>(null)
  const parked = session !== undefined && session.status !== 'live' && session.status !== 'starting'
  // The on-disk history for a parked session is in flight until `fetched` resolves;
  // show a loader instead of the "no transcript" empty state during that window.
  const loadingTranscript = parked && fetched === null
  // A parked-but-recoverable session can still take a composed message — submitting
  // wakes it and the text is delivered once it's ready (auto-resume on submit).
  const canResume =
    session?.status === 'hibernated' ||
    (session?.status === 'exited' && session?.resumable === true)
  // Draft lives in the store, keyed by session — shared across every view of this
  // session and preserved when toggling chat/native or splitting panes.
  const draft = drafts[sessionId] ?? ''
  const setDraft = (text: string) => setSessionDraft(sessionId, text)
  const [query, setQuery] = useState('')
  const [matchCursor, setMatchCursor] = useState(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const pinnedToBottom = useRef(true)
  // One-shot: snap to the newest message the first time a transcript populates
  // (initial load / session switch), not just on incremental growth.
  const didInitialScroll = useRef(false)
  const [atBottom, setAtBottom] = useState(true)
  const [pending, setPending] = useState<PendingItem[]>([])
  const pendingSeq = useRef(0)
  // Block ids seen on the previous render — lets us detect *newly arrived* user
  // blocks so a freshly-echoed prompt reconciles its optimistic bubble.
  const seenUserIds = useRef<Set<string>>(new Set())
  const [justSent, setJustSent] = useState(false)
  const voice = useVoiceInput((text) => setDraft(draft ? `${draft} ${text}` : text))

  useEffect(() => hub.subscribeTranscript(sessionId, setItems), [hub, sessionId])

  useEffect(() => {
    if (!parked) {
      setFetched(null)
      return
    }
    let cancelled = false
    trpc.sessions.transcript
      .query({ sessionId })
      .then((r) => {
        if (!cancelled) setFetched(r.items)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [parked, sessionId, trpc])

  const effectiveItems = parked && fetched && fetched.length > 0 ? fetched : items
  const blocks = useMemo(() => pairToolResults(effectiveItems), [effectiveItems])
  const matches = useMemo(() => searchBlocks(blocks, query), [blocks, query])
  const activeMatch = matches.length > 0 ? matches[matchCursor % matches.length] : undefined

  // A mobile AgentPanel reuses one ChatView instance across sessions (it isn't
  // keyed by sessionId like the desktop tabs are), so reset per-session local UI
  // state on a session switch — otherwise a stale optimistic bubble or "Sending…"
  // row from the previous session bleeds into the newly selected one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on session switch
  useEffect(() => {
    setPending([])
    setJustSent(false)
    seenUserIds.current = new Set()
    pinnedToBottom.current = true
    didInitialScroll.current = false
  }, [sessionId])

  useEffect(() => {
    const prev = seenUserIds.current
    const next = new Set<string>()
    const newUserTexts: string[] = []
    for (const b of blocks) {
      if (b.item.role !== 'user') continue
      next.add(b.item.id)
      if (!prev.has(b.item.id)) newUserTexts.push(b.item.text)
    }
    seenUserIds.current = next
    if (newUserTexts.length > 0) {
      setPending((p) => (p.length === 0 ? p : reconcilePending(p, newUserTexts)))
    }
  }, [blocks])

  // Drop the "sending" affordance after a grace period even if no echo arrived
  // (slow tail / uninstrumented) — the prompt was still sent, so settle to 'sent'
  // (a plain bubble), NOT 'failed'. Only an actual send rejection marks 'failed'.
  useEffect(() => {
    if (!pending.some((p) => p.state === 'sending')) return
    const t = setTimeout(() => {
      setPending((p) => p.map((x) => (x.state === 'sending' ? { ...x, state: 'sent' } : x)))
    }, 30_000)
    return () => clearTimeout(t)
  }, [pending])

  // Clear the optimistic flag once the agent actually reports working (the badge
  // keeps the row visible) or after a short ceiling so it never sticks.
  useEffect(() => {
    if (!justSent) return
    if (session?.agentState?.phase === 'working' || session?.agentState?.phase === 'compacting') {
      setJustSent(false)
      return
    }
    const t = setTimeout(() => setJustSent(false), 8_000)
    return () => clearTimeout(t)
  }, [justSent, session?.agentState?.phase])

  // Follow the live tail unless the user scrolled up to read. Re-runs as blocks
  // arrive (snapshot lands after mount, then live appends) — an empty dep array
  // fired once before any transcript existed and never followed the stream.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the block list grows
  useEffect(() => {
    const el = scrollerRef.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [blocks.length])
  // Initial-load snap: the growth effect above can fire before markdown/code
  // blocks have laid out (it measures a shorter scrollHeight and lands above the
  // tail). On the first populated render, defer two frames so layout settles,
  // then pin to the bottom. One-shot per session — incremental growth is handled
  // above and must still honour a user who scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot keyed off the block count
  useEffect(() => {
    if (didInitialScroll.current || blocks.length === 0) return
    didInitialScroll.current = true
    const el = scrollerRef.current
    if (!el) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pinnedToBottom.current) el.scrollTop = el.scrollHeight
      })
    })
  }, [blocks.length])
  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinnedToBottom.current = near
    setAtBottom(near)
  }
  const jumpToBottom = () => {
    const el = scrollerRef.current
    if (!el) return
    pinnedToBottom.current = true
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }

  // Auto-grow the composer with its content, capped by the max-height (~8
  // lines), after which it scrolls. Runs on every draft change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the draft changes
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [draft])

  const scrollToBlock = (index: number) => {
    scrollerRef.current
      ?.querySelector(`[data-block="${index}"]`)
      ?.scrollIntoView({ block: 'center' })
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolling is the effect of cursor moves
  useEffect(() => {
    if (activeMatch !== undefined) scrollToBlock(activeMatch)
  }, [activeMatch])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    pinnedToBottom.current = true
    setAtBottom(true)
    const id = `pending-${++pendingSeq.current}`
    setPending((p) => [...p, { id, text, at: Date.now(), state: 'sending' }])
    setJustSent(true)
    try {
      // Live → send straight through. Parked but recoverable → wake it and let
      // the server deliver the text once the resumed CLI is ready.
      if (session?.status === 'live' || session?.status === 'starting') {
        await trpc.sessions.sendText.mutate({ sessionId, text })
      } else {
        await resumeAndSend(sessionId, text)
      }
    } catch {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'failed' } : x)))
    }
  }

  const sendable = session?.status === 'live' || session?.status === 'starting'
  // The composer accepts input when the agent is live OR when it can be woken by
  // sending (auto-resume). Only a truly dead/unrecoverable session locks it out.
  const composerEnabled = sendable || canResume
  const activity = chatActivity(session, justSent)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
        <Input
          type="text"
          placeholder="Search transcript…"
          className="h-auto flex-1 rounded-md bg-background px-2.5 py-1 text-xs text-foreground"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setMatchCursor(0)
          }}
        />
        {query && (
          <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] text-muted-foreground">
            {matches.length === 0
              ? '0'
              : `${(matchCursor % Math.max(1, matches.length)) + 1}/${matches.length}`}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="Previous match"
              className="size-auto rounded-none p-0.5 text-muted-foreground hover:bg-transparent hover:text-foreground"
              onClick={() =>
                setMatchCursor((c) => (c - 1 + matches.length) % Math.max(1, matches.length))
              }
            >
              <ChevronUp size={13} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="Next match"
              className="size-auto rounded-none p-0.5 text-muted-foreground hover:bg-transparent hover:text-foreground"
              onClick={() => setMatchCursor((c) => (c + 1) % Math.max(1, matches.length))}
            >
              <ChevronDown size={13} aria-hidden="true" />
            </Button>
          </span>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div
          className="flex min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto px-[18px] pt-3.5 pb-5"
          ref={scrollerRef}
          onScroll={onScroll}
        >
          {blocks.length === 0 && loadingTranscript && (
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
          {blocks.length === 0 && !loadingTranscript && (
            <div className="mx-auto my-6 max-w-[46ch] text-center text-[13px] text-muted-foreground/70">
              No transcript yet. For Claude and Grok sessions the feed starts with the first prompt;
              shells and Codex sessions have no structured transcript (yet).
            </div>
          )}
          {blocks.map((block, i) => (
            <ChatBlockView
              key={block.item.id}
              block={block}
              index={i}
              highlighted={i === activeMatch}
              dimmed={query.trim() !== '' && !blockMatches(block, query)}
            />
          ))}
          {pending.map((p) => (
            <div
              key={p.id}
              className={cn(
                'mx-auto w-full max-w-[760px] rounded-[10px] border border-border bg-secondary px-3.5 py-2.5',
                p.state === 'failed' && 'border-destructive/60',
              )}
            >
              <div className="mb-[3px] flex items-center gap-1.5 text-[10px] uppercase tracking-[0.07em] text-muted-foreground/70">
                You
                {p.state === 'sending' && <span className="normal-case tracking-normal opacity-70">· sending…</span>}
                {p.state === 'failed' && <span className="normal-case tracking-normal text-destructive">· not delivered</span>}
              </div>
              <div className="whitespace-pre-wrap break-words text-sm leading-[1.45] text-foreground">
                {p.text}
              </div>
            </div>
          ))}
          {activity && (
            <div
              role="status"
              aria-live="polite"
              className={cn(
                'mx-auto flex w-full max-w-[760px] items-center gap-2 text-xs',
                // Match the shared status palette: working → green, needs-you →
                // yellow, everything else muted.
                activity.tone === 'attention'
                  ? 'text-amber-500'
                  : activity.tone === 'working'
                    ? 'text-emerald-500'
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
        </div>
        <Minimap blocks={blocks} scrollerRef={scrollerRef} onJump={scrollToBlock} />
        {!atBottom && (
          <button
            type="button"
            className="absolute bottom-3 left-1/2 z-[4] inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-input bg-muted px-3 py-[5px] text-xs text-foreground shadow-[0_4px_14px_rgba(0,0,0,0.4)] hover:border-primary"
            onClick={jumpToBottom}
          >
            <ArrowDownToLine size={13} aria-hidden="true" /> Jump to bottom
          </button>
        )}
      </div>
      {/* Composer: one auto-growing box (≈2 lines, up to 8) with the attach /
          voice / send actions inside it, Claude-iOS style. Enter inserts a
          newline; the send button (or ⌘/Ctrl+Enter) submits. */}
      <div className="border-t border-border bg-card px-3 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom,0px))]">
        <div className="flex flex-col gap-0.5 rounded-2xl border border-input bg-background px-2.5 pt-2 pb-1.5 focus-within:border-primary">
          <Textarea
            ref={taRef}
            rows={1}
            placeholder={
              sendable
                ? 'Message the agent…'
                : canResume
                  ? 'Message — resumes the agent…'
                  : 'Session is not running.'
            }
            className="max-h-44 min-h-11 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0.5 text-sm leading-[1.45] text-foreground transition-none outline-none [field-sizing:fixed] focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100 dark:bg-transparent dark:disabled:bg-transparent"
            value={draft}
            disabled={!composerEnabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Desktop power-shortcut: ⌘/Ctrl+Enter submits. Plain Enter is a
              // newline (the send button submits), matching the mobile keyboard.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="rounded-full text-muted-foreground hover:bg-transparent [&_svg:not([class*='size-'])]:size-4"
              disabled
              title="Attachments — coming soon"
            >
              <Paperclip size={16} aria-hidden="true" />
            </Button>
            {voice.supported && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "rounded-full text-muted-foreground hover:bg-transparent hover:text-foreground [&_svg:not([class*='size-'])]:size-4",
                  voice.listening && 'animate-pulse text-destructive hover:text-destructive',
                )}
                title={voice.listening ? 'Stop voice input' : 'Voice input'}
                onClick={voice.toggle}
              >
                <Mic size={16} aria-hidden="true" />
              </Button>
            )}
            <Button
              type="button"
              size="icon"
              className="rounded-full bg-primary text-primary-foreground hover:bg-primary/80 disabled:bg-secondary disabled:text-muted-foreground/70 disabled:opacity-100 [&_svg:not([class*='size-'])]:size-4"
              disabled={!composerEnabled || !draft.trim()}
              title="Send (⌘/Ctrl+Enter)"
              onClick={() => void send()}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Memoized: ChatView re-renders on every search keystroke, every 700ms
// transcript poll, and every session-state change in the store. Block identity
// is stable across renders that don't change `items` (pairToolResults is
// memoized), so memo skips the expensive markdown re-render for unaffected rows.
const ChatBlockView = memo(function ChatBlockView({
  block,
  index,
  highlighted,
  dimmed,
}: {
  block: ChatBlock
  index: number
  highlighted: boolean
  dimmed: boolean
}): JSX.Element | null {
  const { item } = block
  const html = useMemo(() => renderMarkdown(item.text), [item.text])
  const blockClass = cn(
    'mx-auto w-full max-w-[760px]',
    highlighted && 'rounded-md outline outline-1 outline-primary outline-offset-4',
    dimmed && 'opacity-35',
  )

  if (item.role === 'tool' && item.toolName === 'AskUserQuestion' && item.toolInputJson)
    return <AskUserQuestionCard block={block} cls={blockClass} index={index} />
  if (item.role === 'tool') return <ToolBlock block={block} cls={blockClass} index={index} />

  // A recognized user action that isn't a chat message (e.g. interrupt) — show it
  // as a thin inline divider, not a "You" bubble.
  if (item.event === 'interrupt') {
    return (
      <div
        data-block={index}
        className={cn(
          blockClass,
          'flex items-center gap-2 text-[10px] uppercase tracking-[0.07em] text-muted-foreground/55',
        )}
      >
        <span className="h-px flex-1 bg-border" />
        Interrupted
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }

  const roleClass = cn(
    item.role === 'user' && 'rounded-[10px] border border-border bg-secondary px-3.5 py-2.5',
    item.role === 'system' && 'text-xs text-muted-foreground',
    // The turn's final answer (stop_reason end_turn) — give it a distinct agent
    // bubble so it stands out from the intermediate narration above it.
    item.role === 'assistant' &&
      item.answer &&
      'rounded-[10px] border border-primary/25 bg-primary/[0.05] px-3.5 py-2.5',
  )

  return (
    <div className={cn(blockClass, roleClass)} data-block={index}>
      {item.role === 'user' && (
        <div className="mb-[3px] text-[10px] uppercase tracking-[0.07em] text-muted-foreground/70">
          You
        </div>
      )}
      {item.role === 'system' && (
        <div className="mb-[3px] text-[10px] uppercase tracking-[0.07em] text-muted-foreground/70">
          System
        </div>
      )}
      {item.role === 'assistant' && item.answer && (
        <div className="mb-[3px] text-[10px] uppercase tracking-[0.07em] text-primary/70">Answer</div>
      )}
      <div
        className="chat-md"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {item.tags && item.tags.length > 0 && (
        <div className="mt-1.5 flex gap-1.5">
          {item.tags.map((tag, i) => (
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
  )
})

interface AskOption {
  label: string
  description?: string
}
interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options?: AskOption[]
}

/**
 * The agent asking the human (AskUserQuestion) — render the question(s) and
 * options as a readable card instead of a collapsed tool row, with the chosen
 * option highlighted once answered. (Answering a *live* pending question from
 * here is a separate feature — it needs to drive the native prompt selection.)
 */
function AskUserQuestionCard({
  block,
  cls,
  index,
}: {
  block: ChatBlock
  cls: string
  index: number
}): JSX.Element {
  const { item } = block
  let questions: AskQuestion[] = []
  try {
    const parsed = JSON.parse(item.toolInputJson ?? '{}')
    if (Array.isArray(parsed?.questions)) questions = parsed.questions
  } catch {
    // malformed input — fall through to an empty card
  }
  // The answer arrives as: …"<question>"="<chosen label>"… — match per option.
  const answer = block.result ?? item.toolResult ?? ''
  const isChosen = (label: string) => answer.includes(`"${label}"`)

  return (
    <div
      className={cn(cls, 'rounded-[10px] border border-amber-500/40 bg-amber-500/[0.05] px-3.5 py-2.5')}
      data-block={index}
    >
      <div className="mb-1.5 text-[10px] uppercase tracking-[0.07em] text-amber-600 dark:text-amber-400/90">
        Question for you
      </div>
      {questions.map((q, qi) => (
        <div key={`${q.header ?? q.question}-${qi}`} className={qi > 0 ? 'mt-3' : ''}>
          {q.header && (
            <div className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground/70">
              {q.header}
            </div>
          )}
          <div className="text-sm font-medium text-foreground">{q.question}</div>
          <div className="mt-1.5 flex flex-col gap-1">
            {(q.options ?? []).map((o, oi) => {
              const chosen = isChosen(o.label)
              return (
                <div
                  key={`${o.label}-${oi}`}
                  className={cn(
                    'rounded-md border px-2.5 py-1.5 text-xs',
                    chosen
                      ? 'border-amber-500 bg-amber-500/15 text-foreground'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  <span className="font-medium text-foreground">
                    {chosen ? '✓ ' : ''}
                    {o.label}
                  </span>
                  {o.description && (
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/80">
                      {o.description}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {questions.length === 0 && (
        <div className="text-xs text-muted-foreground">AskUserQuestion (unparseable input)</div>
      )}
    </div>
  )
}

function ToolBlock({
  block,
  cls,
  index,
}: {
  block: ChatBlock
  cls: string
  index: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const { item } = block
  const result = block.result ?? item.toolResult
  // Orphan results render as a bare result row; calls render name + input.
  const label = item.toolName ?? 'result'
  return (
    <div className={cls} data-block={index}>
      <button
        type="button"
        className="flex w-full min-w-0 items-baseline gap-[7px] py-0.5 text-left text-xs text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex-none text-[10px] text-muted-foreground/70">{open ? '▾' : '▸'}</span>
        <span className="flex-none text-xs font-semibold text-foreground">{label}</span>
        {item.toolInput && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
            {item.toolInput}
          </span>
        )}
      </button>
      {open && (
        <pre className="my-1 ml-[17px] max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-2.5 py-2 text-[11px] text-muted-foreground">
          {result ?? '(no result captured)'}
        </pre>
      )}
    </div>
  )
}

/**
 * Birds-eye strip: one slab per block, log-weighted by length; user prompts
 * pop in accent so "where did I steer" reads at a glance. A viewport box
 * mirrors the scroll position; clicking anywhere jumps there.
 */
function Minimap({
  blocks,
  scrollerRef,
  onJump,
}: {
  blocks: ChatBlock[]
  scrollerRef: React.RefObject<HTMLDivElement | null>
  onJump: (index: number) => void
}): JSX.Element | null {
  const segments = useMemo(() => minimapSegments(blocks), [blocks])
  const [viewport, setViewport] = useState({ top: 0, height: 1 })

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const update = () => {
      const total = el.scrollHeight || 1
      setViewport({ top: el.scrollTop / total, height: el.clientHeight / total })
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [scrollerRef])

  if (segments.length < 2) return null
  const totalWeight = segments.reduce((sum, s) => sum + s.weight, 0)
  return (
    <div
      className="relative my-1 mr-[3px] flex flex-[0_0_14px] flex-col gap-px overflow-hidden rounded-[3px]"
      role="presentation"
    >
      {segments.map((seg) => (
        <button
          key={seg.index}
          type="button"
          className={cn(
            'min-h-0.5 w-full cursor-pointer border-0 p-0',
            // Exactly one bg (mutually exclusive — Tailwind doesn't honour class
            // order for conflicting utilities). Theme-independent hues so the
            // light-theme primary (near-black) doesn't collide with agent prose.
            // Priority of attention: user prompts (most important) > final answer >
            // intermediate agent prose (faint) > tool/system (faintest texture).
            seg.role === 'user'
              ? 'bg-blue-500'
              : seg.answer
                ? 'bg-emerald-500'
                : seg.role === 'assistant'
                  ? 'bg-foreground/15'
                  : 'bg-foreground/[0.06]',
          )}
          style={{ height: `${(seg.weight / totalWeight) * 100}%` }}
          title={blocks[seg.index]?.item.text.slice(0, 80) || blocks[seg.index]?.item.toolName}
          onClick={() => onJump(seg.index)}
        />
      ))}
      <div
        className="pointer-events-none absolute inset-x-0 rounded-[2px] border border-foreground/25 bg-foreground/10"
        style={{
          top: `${viewport.top * 100}%`,
          height: `${Math.max(0.04, viewport.height) * 100}%`,
        }}
      />
    </div>
  )
}
