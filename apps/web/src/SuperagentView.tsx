import type { AgentKind, TranscriptItem } from '@podium/protocol'
import { ArrowUpRight, Eraser, Mic, PanelRightClose, Send, Sparkles } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { mergeByCursor } from './chat'
import { agentBadge, panelLabel, reposToViews, sessionDotClass } from './derive'
import { renderMarkdown } from './markdown'
import { useStore } from './store'
import { useConversationSearch } from './useConversationSearch'
import { useVoiceInput } from './voice'
import { KindIcon, sessionDisplayName } from './WorkerLabel'

interface SuperMessage {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolCalls?: { id: string; name: string; arguments: string }[]
  toolCallId?: string
  toolName?: string
  createdAt: string
}

interface SuperThread {
  id: string
  kind: 'global' | 'btw'
  originSessionId?: string
  title?: string
}

interface AtOption {
  kind: 'repo' | 'worktree' | 'conversation'
  label: string
  detail: string
  /** What lands in the input: @label(ref). */
  ref: string
}

/**
 * The superagent: an orchestrator chat with cross-project context and tools.
 * `@` in the input opens the context menu — repos, worktrees, conversations
 * (files later) — and inserts an @label(ref) token the agent understands.
 */
export function SuperagentView({ onClose }: { onClose?: () => void } = {}): JSX.Element {
  const { trpc, repos, superThreadId, setSuperThreadId, superRefreshKey } = useStore()
  const [messages, setMessages] = useState<SuperMessage[]>([])
  const [threads, setThreads] = useState<SuperThread[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [backendLabel, setBackendLabel] = useState('')
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const [atIndex, setAtIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const voice = useVoiceInput((text) => setDraft((d) => (d ? `${d} ${text}` : text)))

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on thread switch + after seeding
  useEffect(() => {
    trpc.superagent.history
      .query({ threadId: superThreadId })
      .then((h) => setMessages(h as SuperMessage[]))
      .catch(() => {})
  }, [trpc, superThreadId, superRefreshKey])

  // Thread list (Global + btw threads); refresh when the active thread changes or a
  // btw thread finishes seeding, so it shows up in the switcher.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on thread switch + after seeding
  useEffect(() => {
    trpc.superagent.listThreads
      .query()
      .then((t) => setThreads(t as SuperThread[]))
      .catch(() => {})
  }, [trpc, superThreadId, superRefreshKey])

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll follows new messages
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, busy])

  // ---- @ context menu ----
  const localAtOptions = useMemo<AtOption[]>(() => {
    const views = reposToViews(repos)
    const out: AtOption[] = []
    for (const repo of views) {
      out.push({ kind: 'repo', label: repo.name, detail: repo.path, ref: repo.path })
      for (const wt of repo.worktrees) {
        if (wt.isMain) continue
        out.push({
          kind: 'worktree',
          label: `${repo.name}/${wt.branch ?? wt.path.split('/').pop()}`,
          detail: wt.path,
          ref: wt.path,
        })
      }
    }
    return out
  }, [repos])

  // Conversations join the @-menu async via the shared (race-guarded) search;
  // files come later. The menu is derived, not stored, so a slow stale response
  // can't overwrite the current query's options.
  const { hits: convHits } = useConversationSearch({
    query: atQuery ?? '',
    limit: 4,
    enabled: atQuery !== null,
    debounceMs: 150,
  })
  const atHits = useMemo<AtOption[]>(() => {
    if (atQuery === null) return []
    const q = atQuery.toLowerCase()
    const local = localAtOptions
      .filter((o) => o.label.toLowerCase().includes(q) || o.detail.toLowerCase().includes(q))
      .slice(0, 6)
    const convs = convHits.map(
      (hit): AtOption => ({
        kind: 'conversation',
        label: hit.name || hit.title || hit.id,
        detail: hit.projectPath?.split('/').slice(-2).join('/') ?? '',
        ref: `conversation:${hit.id}`,
      }),
    )
    return [...local, ...convs].slice(0, 10)
  }, [atQuery, localAtOptions, convHits])
  // Keep the highlighted index in range as the option list changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on query change
  useEffect(() => setAtIndex(0), [atQuery])

  const syncAtState = (value: string, caret: number) => {
    // An @-mention is active when the text before the caret ends in @word.
    const before = value.slice(0, caret)
    const match = /(?:^|\s)@([\w./-]*)$/.exec(before)
    setAtQuery(match ? (match[1] ?? '') : null)
  }

  const insertAt = (option: AtOption) => {
    const el = inputRef.current
    const caret = el?.selectionStart ?? draft.length
    const before = draft.slice(0, caret).replace(/@([\w./-]*)$/, '')
    const token = `@${option.label}(${option.ref}) `
    setDraft(before + token + draft.slice(caret))
    setAtQuery(null)
    el?.focus()
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    setAtQuery(null)
    setBusy(true)
    // Optimistic local echo; the server returns the persisted turn.
    const optimistic: SuperMessage = {
      id: -Date.now(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    }
    setMessages((m) => [...m, optimistic])
    try {
      const turn = (await trpc.superagent.send.mutate({ threadId: superThreadId, text })) as {
        messages: SuperMessage[]
        backendLabel: string
      }
      setBackendLabel(turn.backendLabel)
      setMessages((m) => [...m.filter((x) => x.id !== optimistic.id), ...turn.messages])
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          id: -Date.now() - 1,
          role: 'assistant',
          content: `Request failed: ${e instanceof Error ? e.message : String(e)}`,
          createdAt: new Date().toISOString(),
        },
      ])
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    await trpc.superagent.clear.mutate({ threadId: superThreadId }).catch(() => {})
    setMessages([])
    // Clearing a btw thread archives it server-side; fall back to the global thread.
    if (superThreadId !== 'global') setSuperThreadId('global')
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-3">
        <h1 className="m-0 inline-flex items-center gap-[7px] text-[15px] font-medium text-foreground">
          <Sparkles size={16} aria-hidden="true" /> Superagent
        </h1>
        {threads.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Superagent threads">
            {threads.map((th) => (
              <button
                key={th.id}
                type="button"
                role="tab"
                aria-selected={th.id === superThreadId}
                className={cn(
                  'cursor-pointer rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                  th.id === superThreadId
                    ? 'border-muted-foreground text-foreground'
                    : 'border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground',
                )}
                title={th.kind === 'btw' ? 'BTW thread for a chat session' : 'Global orchestrator'}
                onClick={() => setSuperThreadId(th.id)}
              >
                {th.id === 'global' ? 'Global' : (th.title ?? th.originSessionId ?? th.id)}
              </button>
            ))}
          </div>
        )}
        <span className="text-[11px] text-muted-foreground/70">{backendLabel}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          title={superThreadId === 'global' ? 'Clear thread' : 'Close this BTW thread'}
          onClick={() => void clear()}
        >
          <Eraser size={14} aria-hidden="true" />
        </Button>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Collapse the superagent panel"
            onClick={onClose}
          >
            <PanelRightClose size={15} aria-hidden="true" />
          </Button>
        )}
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-[18px] py-3.5"
        ref={scrollRef}
      >
        {messages.length === 0 && (
          <div className="mx-auto my-6 max-w-[46ch] text-center text-[13px] text-muted-foreground/70">
            Your orchestrator. Ask it to start agents, set up worktrees, dig through past
            conversations, or work tickets. Type{' '}
            <code className="rounded-sm bg-background px-[3px] font-mono text-[0.92em]">@</code> to
            reference a repo, worktree, or conversation.
          </div>
        )}
        {messages.map((m) => (
          <SuperMessageView key={m.id} message={m} />
        ))}
        {busy && (
          <div className="mx-auto w-full max-w-[760px] animate-pulse text-xs text-muted-foreground/70">
            Thinking…
          </div>
        )}
      </div>
      <div className="flex items-end gap-2 border-t border-border bg-card px-3.5 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom,0px))]">
        <div className="relative flex min-w-0 flex-1">
          {atQuery !== null && atHits.length > 0 && (
            <div
              className="absolute right-0 bottom-[calc(100%+6px)] left-0 z-30 flex max-w-[460px] flex-col overflow-hidden rounded-md border border-input bg-muted shadow-[0_-8px_24px_rgb(0_0_0_/_0.4)]"
              role="listbox"
            >
              {atHits.map((option, i) => (
                <button
                  key={`${option.kind}-${option.ref}`}
                  type="button"
                  role="option"
                  aria-selected={i === atIndex}
                  className={cn(
                    'flex w-full min-w-0 cursor-pointer items-baseline gap-2 px-2.5 py-[7px] text-left text-xs',
                    i === atIndex ? 'bg-accent text-foreground' : 'text-foreground',
                  )}
                  onMouseEnter={() => setAtIndex(i)}
                  onClick={() => insertAt(option)}
                >
                  <span className="w-[86px] flex-none text-[10px] uppercase tracking-[0.05em] text-primary">
                    {option.kind}
                  </span>
                  <span className="max-w-[45%] flex-none overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
                    {option.label}
                  </span>
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground/70">
                    {option.detail}
                  </span>
                </button>
              ))}
              <div className="border-t border-border px-2.5 pt-1 pb-1.5 text-[10px] text-muted-foreground/70">
                files: coming later
              </div>
            </div>
          )}
          <Textarea
            ref={inputRef}
            className="min-h-0 flex-1 resize-none rounded-[10px] border-input bg-background px-3 py-[9px] text-[13px] leading-[1.45] text-foreground field-sizing-fixed focus-visible:border-primary focus-visible:ring-0"
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder="Orchestrate… (@ for context, Enter to send)"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              syncAtState(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onKeyDown={(e) => {
              if (atQuery !== null && atHits.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setAtIndex((i) => (i + 1) % atHits.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setAtIndex((i) => (i - 1 + atHits.length) % atHits.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  const pick = atHits[atIndex]
                  if (pick) insertAt(pick)
                  return
                }
                if (e.key === 'Escape') {
                  setAtQuery(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
        </div>
        {voice.supported && (
          <button
            type="button"
            className={cn(
              'flex size-9 flex-none items-center justify-center rounded-full border border-input bg-secondary text-foreground transition-colors hover:border-primary hover:text-foreground',
              voice.listening && 'animate-pulse border-destructive text-destructive',
            )}
            title={voice.listening ? 'Stop voice input' : 'Voice input'}
            onClick={voice.toggle}
          >
            <Mic size={15} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="flex size-9 flex-none items-center justify-center rounded-full border border-input bg-secondary text-foreground transition-colors hover:border-primary hover:text-foreground disabled:cursor-default disabled:opacity-40"
          disabled={busy || !draft.trim()}
          title="Send"
          onClick={() => void send()}
        >
          <Send size={15} aria-hidden="true" />
        </button>
      </div>
    </section>
  )
}

/** A worker session the superagent spawned (`start_agent` result): a live,
 *  clickable card — one click opens it in the workspace, and "Follow" expands a
 *  live transcript tail so you can watch progress without leaving the chat. */
function SpawnedAgentCard({
  sessionId,
  cwd,
  agentKind,
}: {
  sessionId: string
  cwd: string
  agentKind: AgentKind
}): JSX.Element {
  const { sessions, setPane, setSelectedWorktree, setView, hub } = useStore()
  const [following, setFollowing] = useState(false)
  const session = sessions.find((s) => s.sessionId === sessionId)
  const status = session ? (agentBadge(session)?.label ?? session.status) : 'starting…'
  const open = () => {
    setSelectedWorktree(cwd)
    setPane('A', sessionId)
    setView('workspace')
  }
  return (
    <div className="mx-auto w-full max-w-[760px] overflow-hidden rounded-[10px] border border-border bg-background">
      <div className="flex items-center gap-2 px-3 py-2">
        {session ? (
          <span className={sessionDotClass(session)} />
        ) : (
          <span className="inline-block size-2 min-w-2 flex-none animate-pulse rounded-full bg-blue-500" />
        )}
        <KindIcon
          kind={agentKind}
          dimmed={session?.status === 'hibernated' || session?.status === 'exited'}
        />
        <button
          type="button"
          onClick={open}
          className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground hover:text-primary"
          title={session ? sessionDisplayName(session) : sessionId}
        >
          {session ? sessionDisplayName(session) : `${panelLabel(agentKind)} agent`}
        </button>
        <span className="flex-none text-[11px] text-muted-foreground/70">{status}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex-none"
          onClick={() => setFollowing((v) => !v)}
        >
          {following ? 'Hide' : 'Follow'}
        </Button>
        <Button type="button" variant="outline" size="sm" className="flex-none" onClick={open}>
          Open <ArrowUpRight size={12} aria-hidden="true" />
        </Button>
      </div>
      {following && <SpawnedFollow sessionId={sessionId} hub={hub} />}
    </div>
  )
}

/** Inline live transcript tail for a spawned worker — the last few items, kept
 *  scrolled to the newest, so you can follow what it's doing within the chat. */
export function SpawnedFollow({
  sessionId,
  hub,
}: {
  sessionId: string
  hub: ReturnType<typeof useStore>['hub']
}): JSX.Element {
  const [items, setItems] = useState<TranscriptItem[]>([])
  const endRef = useRef<HTMLDivElement | null>(null)
  // Live tail only (no initial read — this inline follow just shows the last few
  // items as they stream). The hub now forwards per-frame DELTAS, so accumulate
  // them; a reset (file roll / reattach re-seed) clears the local buffer.
  useEffect(() => {
    setItems([])
    return hub.subscribeTranscript(sessionId, undefined, (delta, meta) => {
      setItems((prev) => (meta.reset ? delta : mergeByCursor(prev, delta)))
    })
  }, [hub, sessionId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the tail
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [items.length])
  const tail = items.slice(-8)
  return (
    <div className="max-h-[220px] overflow-auto border-t border-border bg-card/40 px-3 py-2 text-[11px] leading-relaxed">
      {tail.length === 0 ? (
        <span className="text-muted-foreground/70">No transcript yet…</span>
      ) : (
        tail.map((it) => (
          <div key={it.id} className="min-w-0 truncate">
            <span className="text-muted-foreground/60">
              {it.role === 'tool' ? '⚙' : it.role === 'user' ? '›' : '·'}{' '}
            </span>
            <span className={it.role === 'user' ? 'text-foreground' : 'text-muted-foreground'}>
              {it.text?.slice(0, 160) || it.toolName || ''}
            </span>
          </div>
        ))
      )}
      <div ref={endRef} />
    </div>
  )
}

function SuperMessageView({ message }: { message: SuperMessage }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  // A spawned worker session — render it as a live, openable card instead of a
  // raw JSON tool result.
  if (message.role === 'tool' && message.toolName === 'start_agent') {
    try {
      const parsed = JSON.parse(message.content) as {
        sessionId?: string
        cwd?: string
        agentKind?: string
      }
      if (parsed.sessionId) {
        return (
          <SpawnedAgentCard
            sessionId={parsed.sessionId}
            cwd={parsed.cwd ?? ''}
            agentKind={(parsed.agentKind as AgentKind) ?? 'claude-code'}
          />
        )
      }
    } catch {
      // malformed result — fall through to the generic tool row
    }
  }
  if (message.role === 'tool') {
    return (
      <div className="mx-auto w-full max-w-[760px]">
        <button
          type="button"
          className="flex w-full min-w-0 cursor-pointer items-baseline gap-[7px] py-0.5 text-left text-xs text-muted-foreground"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="flex-none text-[10px] text-muted-foreground/70">{open ? '▾' : '▸'}</span>
          <span className="flex-none text-xs font-semibold text-foreground">
            {message.toolName ?? 'tool'}
          </span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-muted-foreground/70">
            result
          </span>
        </button>
        {open && (
          <pre className="mt-1 mr-0 mb-1 ml-[17px] max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-2.5 py-2 text-[11px] text-muted-foreground">
            {message.content}
          </pre>
        )}
      </div>
    )
  }
  if (message.role === 'system') return null
  // The btw seed / re-open delta are persisted as user messages so the agent sees
  // them, but they're machine-authored context — collapse them instead of showing a
  // giant "You" bubble.
  if (message.role === 'user' && /^\[BTW (CONTEXT|UPDATE)/.test(message.content)) {
    const label = message.content.startsWith('[BTW UPDATE') ? 'session update' : 'session context'
    return (
      <div className="mx-auto w-full max-w-[760px]">
        <button
          type="button"
          className="flex w-full min-w-0 cursor-pointer items-baseline gap-[7px] py-0.5 text-left text-xs text-muted-foreground"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="flex-none text-[10px] text-muted-foreground/70">{open ? '▾' : '▸'}</span>
          <span className="flex-none text-xs font-semibold text-foreground">{label}</span>
        </button>
        {open && (
          <pre className="mt-1 mr-0 mb-1 ml-[17px] max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-2.5 py-2 text-[11px] text-muted-foreground">
            {message.content}
          </pre>
        )}
      </div>
    )
  }
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-[760px]',
        message.role === 'user' && 'rounded-[10px] border border-border bg-secondary px-3.5 py-2.5',
      )}
    >
      {message.role === 'user' && (
        <div className="mb-[3px] text-[10px] uppercase tracking-[0.07em] text-muted-foreground/70">
          You
        </div>
      )}
      {message.content && (
        <div
          className="chat-md"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        />
      )}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {message.toolCalls.map((c) => (
            <span
              key={c.id}
              className="rounded-sm border border-input px-[7px] py-px text-[11px] text-muted-foreground"
            >
              ⚙ {c.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
