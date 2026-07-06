import type { AgentKind, TranscriptItem } from '@podium/protocol'
import {
  ArrowUpRight,
  Eraser,
  Mic,
  PanelRightClose,
  Send,
  Sparkles,
  SquareTerminal,
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { CardBoundary } from './CardBoundary'
import { mergeByCursor } from './chat'
import { ChatView } from './ChatView'
import { conciergeLabel, conciergeRepoPath } from './concierge'
import { agentBadge, panelLabel, reposToViews, sessionDotClass } from './derive'
import { useIsMobile } from './hooks/use-is-mobile'
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
  kind: 'global' | 'btw' | 'concierge'
  originSessionId?: string
  title?: string
  repoPath?: string
  /** The headless Podium session rendering this thread (set on the first turn). */
  podiumSessionId?: string
  /** The harness's own session id — present once the thread has a real session. */
  harnessSessionId?: string
}

function superThreadLabel(thread: SuperThread): string {
  if (thread.kind === 'concierge') {
    const repoPath = thread.repoPath ?? conciergeRepoPath(thread.id)
    if (repoPath) return conciergeLabel(repoPath)
  }
  return thread.id === 'global' ? 'Global' : (thread.title ?? thread.originSessionId ?? thread.id)
}

interface AtOption {
  kind: 'repo' | 'worktree' | 'conversation'
  label: string
  detail: string
  /** What lands in the input: @label(ref). */
  ref: string
}

/**
 * The superagent panel (concierge unification, Phase C): a thin shell — thread
 * switcher header + optional legacy-history block — around an embedded ChatView
 * bound to the thread's HEADLESS Podium session. The harness owns the
 * conversation; ChatView renders its real transcript (tool batching, windowing,
 * streaming overlay) and routes sends through superagent.sendTurn.
 *
 * A thread with no session yet (fresh concierge/global thread) shows only a
 * composer; the first send creates the headless session (conciergeTurn /
 * sendTurn ack carries podiumSessionId) and the panel swaps to ChatView.
 */
export function SuperagentView({ onClose }: { onClose?: () => void } = {}): JSX.Element {
  const {
    trpc,
    sessions,
    superThreadId,
    setSuperThreadId,
    superRefreshKey,
    setPane,
    setSelectedWorktree,
    setView,
  } = useStore()
  const [threads, setThreads] = useState<SuperThread[]>([])
  const [legacy, setLegacy] = useState<SuperMessage[]>([])
  const [legacyOpen, setLegacyOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isMobile = useIsMobile()
  // Concierge binding: the active thread's repo, decoded from the deterministic
  // thread id — valid even BEFORE the thread exists server-side (first send
  // creates + seeds it via superagent.concierge).
  const conciergeRepo = conciergeRepoPath(superThreadId)
  const thread = threads.find((t) => t.id === superThreadId)
  const podiumSessionId = thread?.podiumSessionId

  const refreshThreads = () =>
    trpc.superagent.listThreads
      .query()
      .then((t) => setThreads(t as SuperThread[]))
      .catch(() => {})

  // Legacy buffered history (read-only): threads that predate the headless
  // migration keep their old SuperMessage[] as a collapsed block.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on thread switch + after seeding
  useEffect(() => {
    setLegacy([])
    setLegacyOpen(false)
    setError(null)
    trpc.superagent.history
      .query({ threadId: superThreadId })
      .then((h) => setLegacy(h as SuperMessage[]))
      .catch(() => {})
  }, [trpc, superThreadId, superRefreshKey])

  // Thread list (Global + btw/concierge threads); refresh when the active thread
  // changes or a btw thread finishes seeding, so it shows up in the switcher.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on thread switch + after seeding
  useEffect(() => {
    void refreshThreads()
  }, [trpc, superThreadId, superRefreshKey])

  // "Open in terminal": focus the PTY session once its row lands in the
  // sessions broadcast (a fresh resume may beat the broadcast by a beat).
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null)
  useEffect(() => {
    if (!focusSessionId) return
    const s = sessions.find((x) => x.sessionId === focusSessionId)
    if (!s) return
    setFocusSessionId(null)
    setSelectedWorktree(s.cwd)
    setPane('A', s.sessionId)
    setView('workspace')
  }, [focusSessionId, sessions, setSelectedWorktree, setPane, setView])

  const openInTerminal = async () => {
    setError(null)
    try {
      const r = await trpc.superagent.openInTerminal.mutate({ threadId: superThreadId })
      setFocusSessionId(r.sessionId)
      await refreshThreads()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const clear = async () => {
    await trpc.superagent.clear.mutate({ threadId: superThreadId }).catch(() => {})
    setLegacy([])
    // Clearing a btw thread archives it server-side; fall back to the global thread.
    if (superThreadId !== 'global') setSuperThreadId('global')
    void refreshThreads()
  }

  // The superThread ref handed to the embedded ChatView so its composer routes
  // through the turn mutations. Kind falls back on the id shape for threads the
  // list hasn't caught up with yet.
  const threadKind: SuperThread['kind'] =
    thread?.kind ?? (conciergeRepo ? 'concierge' : superThreadId.startsWith('btw_') ? 'btw' : 'global')
  const superThreadRef = {
    threadId: superThreadId,
    kind: threadKind,
    ...(conciergeRepo ? { repoPath: conciergeRepo } : thread?.repoPath ? { repoPath: thread.repoPath } : {}),
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center gap-2.5 border-b border-border px-[18px] py-3">
        <h1 className="m-0 inline-flex flex-none items-center gap-[7px] text-[15px] font-medium text-foreground">
          <Sparkles size={16} aria-hidden="true" />{' '}
          <span className="truncate">
            {conciergeRepo ? conciergeLabel(conciergeRepo) : 'Superagent'}
          </span>
        </h1>
        {threads.length > 1 &&
          (isMobile ? (
            <select
              aria-label="Superagent conversation"
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-[12px] text-foreground outline-none focus:border-primary"
              value={superThreadId}
              onChange={(e) => setSuperThreadId(e.currentTarget.value)}
            >
              {threads.map((th) => (
                <option key={th.id} value={th.id}>
                  {superThreadLabel(th)}
                </option>
              ))}
            </select>
          ) : (
            <div
              className="flex min-w-0 flex-1 flex-nowrap gap-1.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none]"
              role="tablist"
              aria-label="Superagent threads"
            >
              {threads.map((th) => (
                <button
                  key={th.id}
                  type="button"
                  role="tab"
                  aria-selected={th.id === superThreadId}
                  className={cn(
                    'max-w-[220px] flex-none cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                    th.id === superThreadId
                      ? 'border-muted-foreground text-foreground'
                      : 'border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground',
                  )}
                  title={
                    th.kind === 'btw'
                      ? 'BTW thread for a chat session'
                      : th.kind === 'concierge'
                        ? `Concierge intake for ${th.repoPath ?? conciergeRepoPath(th.id) ?? 'a repo'}`
                        : 'Global orchestrator'
                  }
                  onClick={() => setSuperThreadId(th.id)}
                >
                  {superThreadLabel(th)}
                </button>
              ))}
            </div>
          ))}
        {thread?.harnessSessionId && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            title="Open this conversation in a terminal session"
            onClick={() => void openInTerminal()}
          >
            <SquareTerminal size={14} aria-hidden="true" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className={thread?.harnessSessionId ? undefined : 'ml-auto'}
          title={superThreadId === 'global' ? 'Clear thread' : 'Close this thread'}
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
      {error && (
        <div className="border-b border-border px-[18px] py-2 text-[12px] text-destructive">
          {error}
        </div>
      )}
      {legacy.length > 0 && (
        <div className="flex-none border-b border-border px-[18px] py-2">
          <button
            type="button"
            className="flex w-full min-w-0 cursor-pointer items-baseline gap-[7px] py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setLegacyOpen((v) => !v)}
            aria-expanded={legacyOpen}
          >
            <span className="flex-none text-[10px] text-muted-foreground/70">
              {legacyOpen ? '▾' : '▸'}
            </span>
            <span className="flex-none text-xs font-semibold">Earlier conversation</span>
            <span className="text-[11px] text-muted-foreground/70">
              {legacy.length} message{legacy.length === 1 ? '' : 's'}
            </span>
          </button>
          {legacyOpen && (
            <div className="mt-2 flex max-h-[40vh] flex-col gap-2.5 overflow-y-auto">
              {legacy.map((m) => (
                <CardBoundary key={m.id} resetKey={String(m.id)} label="superagent message">
                  <SuperMessageView message={m} />
                </CardBoundary>
              ))}
            </div>
          )}
        </div>
      )}
      {podiumSessionId ? (
        <ChatView sessionId={podiumSessionId} active superThread={superThreadRef} compact />
      ) : (
        <FreshThreadComposer
          key={superThreadId}
          conciergeRepo={conciergeRepo ?? null}
          threadId={superThreadId}
          onError={setError}
          onSent={() => void refreshThreads()}
        />
      )}
    </section>
  )
}

/**
 * The pre-session state of a thread: hint copy + a composer with @-mentions and
 * voice input. The FIRST send runs the turn (conciergeTurn ensures + seeds the
 * per-repo thread; sendTurn covers global/btw threads that already exist) — the
 * ack's podiumSessionId flows back via listThreads and the parent swaps this
 * composer for the embedded ChatView. The just-sent text stays visible as an
 * optimistic bubble until the swap.
 */
function FreshThreadComposer({
  conciergeRepo,
  threadId,
  onError,
  onSent,
}: {
  conciergeRepo: string | null
  threadId: string
  onError: (message: string | null) => void
  onSent: () => void
}): JSX.Element {
  const { trpc, repos } = useStore()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [sentText, setSentText] = useState<string | null>(null)
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const [atIndex, setAtIndex] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const voice = useVoiceInput((text) => setDraft((d) => (d ? `${d} ${text}` : text)))

  // ---- @ context menu (repos, worktrees, conversations) ----
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on query change
  useEffect(() => setAtIndex(0), [atQuery])

  const syncAtState = (value: string, caret: number) => {
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
    setSentText(text)
    onError(null)
    try {
      if (conciergeRepo) {
        await trpc.superagent.concierge.mutate({ repoPath: conciergeRepo, text })
      } else {
        await trpc.superagent.sendTurn.mutate({ threadId, text })
      }
      // The ack minted the headless session — refresh the thread list so the
      // parent swaps to the embedded ChatView (the bubble carries over there
      // via the transcript itself).
      onSent()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      setSentText(null)
      setDraft(text) // give the message back for a retry
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-[18px] py-3.5">
        {sentText === null &&
          (conciergeRepo ? (
            <div className="mx-auto my-6 max-w-[46ch] text-center text-[13px] text-muted-foreground/70">
              Tell the concierge what you want — it finds or files the issues and won't start work
              without your go-ahead.
            </div>
          ) : (
            <div className="mx-auto my-6 max-w-[46ch] text-center text-[13px] text-muted-foreground/70">
              Your orchestrator. Ask it to start agents, set up worktrees, dig through past
              conversations, or work tickets. Type{' '}
              <code className="rounded-sm bg-background px-[3px] font-mono text-[0.92em]">@</code>{' '}
              to reference a repo, worktree, or conversation.
            </div>
          ))}
        {sentText !== null && (
          <>
            <div className="mx-auto w-full max-w-[760px] rounded-[10px] border border-border bg-secondary px-3.5 py-2.5">
              <div className="mb-[3px] text-[10px] uppercase tracking-[0.07em] text-muted-foreground/70">
                You
              </div>
              <div className="chat-md whitespace-pre-wrap">{sentText}</div>
            </div>
            <div className="mx-auto w-full max-w-[760px] animate-pulse text-xs text-muted-foreground/70">
              Starting the conversation…
            </div>
          </>
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
    </>
  )
}

/** A worker session the superagent spawned (`start_agent` result): a live,
 *  clickable card — one click opens it in the workspace, and "Follow" expands a
 *  live transcript tail so you can watch progress without leaving the chat.
 *  Retained for LEGACY history rendering; new-path start_agent results render
 *  through ChatView's normal tool rendering. */
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

/** Read-only renderer for one LEGACY buffered message (the pre-headless
 *  SuperMessage rows). New turns render through the embedded ChatView. */
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
  // The btw/concierge seed / re-open delta are persisted as user messages so the
  // agent sees them, but they're machine-authored context — collapse them instead
  // of showing a giant "You" bubble.
  if (message.role === 'user' && /^\[(BTW|CONCIERGE) (CONTEXT|UPDATE)/.test(message.content)) {
    const label = /^\[(BTW|CONCIERGE) UPDATE/.test(message.content)
      ? message.content.startsWith('[CONCIERGE')
        ? 'repo update'
        : 'session update'
      : message.content.startsWith('[CONCIERGE')
        ? 'repo context'
        : 'session context'
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
