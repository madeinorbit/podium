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
import { renderMarkdown } from './markdown'
import { useStore } from './store'
import { useVoiceInput } from './voice'

/**
 * Claude-app-style chat rendering of a session's structured transcript, with a
 * native write-through input, quick transcript search, and a Sublime-style
 * birds-eye minimap (user prompts highlighted; click scrolls).
 */
export function ChatView({ sessionId }: { sessionId: string }): JSX.Element {
  const { hub, trpc, sessions, drafts, setSessionDraft } = useStore()
  const session = sessions.find((s) => s.sessionId === sessionId)
  const [items, setItems] = useState<TranscriptItem[]>([])
  // A parked session (hibernated/exited) has no live tail and an empty server
  // buffer after a restart, so the stream stays empty. Read its history off disk
  // on demand instead. Prefer it only when the live buffer is empty (a session
  // parked within this server's lifetime still has its buffer).
  const [fetched, setFetched] = useState<TranscriptItem[] | null>(null)
  const parked = session !== undefined && session.status !== 'live' && session.status !== 'starting'
  // Draft lives in the store, keyed by session — shared across every view of this
  // session and preserved when toggling chat/native or splitting panes.
  const draft = drafts[sessionId] ?? ''
  const setDraft = (text: string) => setSessionDraft(sessionId, text)
  const [query, setQuery] = useState('')
  const [matchCursor, setMatchCursor] = useState(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const pinnedToBottom = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [pending, setPending] = useState<PendingItem[]>([])
  const pendingSeq = useRef(0)
  // Block ids seen on the previous render — lets us detect *newly arrived* user
  // blocks so a freshly-echoed prompt reconciles its optimistic bubble.
  const seenUserIds = useRef<Set<string>>(new Set())
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
  // (slow tail / uninstrumented) — the prompt was still sent; keep the bubble.
  useEffect(() => {
    if (!pending.some((p) => p.state === 'sending')) return
    const now = Date.now()
    const t = setTimeout(() => {
      setPending((p) =>
        p.map((x) => (x.state === 'sending' && now - x.at >= 0 ? { ...x, state: 'failed' } : x)),
      )
    }, 30_000)
    return () => clearTimeout(t)
  }, [pending])

  // Follow the live tail unless the user scrolled up to read. Re-runs as blocks
  // arrive (snapshot lands after mount, then live appends) — an empty dep array
  // fired once before any transcript existed and never followed the stream.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the block list grows
  useEffect(() => {
    const el = scrollerRef.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
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
    try {
      await trpc.sessions.sendText.mutate({ sessionId, text })
    } catch {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'failed' } : x)))
    }
  }

  const sendable = session?.status === 'live' || session?.status === 'starting'

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
          {blocks.length === 0 && (
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
            placeholder={sendable ? 'Message the agent…' : 'Session is not running.'}
            className="max-h-44 min-h-11 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0.5 text-sm leading-[1.45] text-foreground transition-none outline-none [field-sizing:fixed] focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100 dark:bg-transparent dark:disabled:bg-transparent"
            value={draft}
            disabled={!sendable}
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
              disabled={!sendable || !draft.trim()}
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

  if (item.role === 'tool') return <ToolBlock block={block} cls={blockClass} index={index} />

  const roleClass = cn(
    item.role === 'user' && 'rounded-[10px] border border-border bg-secondary px-3.5 py-2.5',
    item.role === 'system' && 'text-xs text-muted-foreground',
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
            'min-h-0.5 w-full cursor-pointer border-0 bg-secondary p-0',
            seg.role === 'user' && 'bg-primary',
            seg.role === 'assistant' && 'bg-input',
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
