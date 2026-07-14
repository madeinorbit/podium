import { shallowEqual } from '@podium/client-core/store'
import type { AgentKind, TranscriptItem } from '@podium/protocol'
import {
  ArrowUpRight,
  ChevronDown,
  Eraser,
  Mic,
  PanelRightClose,
  Send,
  SquareTerminal,
} from 'lucide-react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CardBoundary } from '@/app/CardBoundary'
import { type Store, useStoreSelector } from '@/app/store'
import { IdSquare } from '@/components/IdSquare'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ChatView } from '@/features/chat/ChatView'
import { mergeByCursor } from '@/features/chat/chat'
import { BlockCaret } from '@/lib/BlockCaret'
import { agentBadge, panelLabel, reposToViews, sessionDotClass } from '@/lib/derive'
import { renderMarkdown } from '@/lib/markdown'
import { useConversationSearch } from '@/lib/useConversationSearch'
import { cn } from '@/lib/utils'
import { useVoiceInput } from '@/lib/voice'
import { KindIcon, sessionDisplayName } from '@/lib/WorkerLabel'
import {
  readSectionOpen,
  readTrayHeight,
  SUPER_CHAT_OPEN_KEY,
  TRAY_HEIGHT_KEY,
  TRAY_MAX_HEIGHT_RATIO,
  TRAY_MIN_HEIGHT,
  TRAY_OPEN_KEY,
} from './column-state'
import type { TrayItem } from './derive-tray'
import { trayCount } from './derive-tray'
import { EventFeed } from './EventFeed'
import { CountPill, SectionBar, UnreadDot } from './SectionBar'
import { Tray } from './Tray'
import type { TrayActions } from './TrayCard'
import { useIssueEvents } from './useIssueEvents'

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

interface AtOption {
  kind: 'repo' | 'worktree' | 'conversation'
  label: string
  detail: string
  /** What lands in the input: @label(ref). */
  ref: string
}

/** ONE chat across all issues (engraved-column.md §2.5): the column always
 *  binds the global thread; per-turn issue context rides the focus payload.
 *  Per-repo concierge / btw thread history access is #55. */
const THREAD_ID = 'global'

/**
 * The engraved column's CONTENT (issue #42): the Tray — ONLY items needing a
 * human, scoped to the selected issue — above the overarching Super agent
 * chat. Each section collapses to its compact header bar (never further) with
 * its own persisted state; the tray/chat split is drag-resizable. The #40
 * shell owns the column's width and open|folded|closed mode around this.
 */
export function SuperagentView({
  onClose,
  mobile = false,
}: {
  onClose?: () => void
  mobile?: boolean
} = {}): JSX.Element {
  const {
    hub,
    trpc,
    sessions,
    issues,
    selectedIssueId,
    superRefreshKey,
    setPane,
    setSelectedWorktree,
    setSelectedIssueId,
    setView,
    uiState,
    setSessionDraft,
    getUserFocus,
  } = useStoreSelector(
    (s) => ({
      hub: s.hub,
      trpc: s.trpc,
      sessions: s.sessions,
      issues: s.issues,
      selectedIssueId: s.selectedIssueId,
      superRefreshKey: s.superRefreshKey,
      setPane: s.setPane,
      setSelectedWorktree: s.setSelectedWorktree,
      setSelectedIssueId: s.setSelectedIssueId,
      setView: s.setView,
      uiState: s.uiState,
      setSessionDraft: s.setSessionDraft,
      getUserFocus: s.getUserFocus,
    }),
    shallowEqual,
  )
  const [threads, setThreads] = useState<SuperThread[]>([])
  const [legacy, setLegacy] = useState<SuperMessage[]>([])
  const [legacyOpen, setLegacyOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingDraft, setPendingDraft] = useState('')
  const thread = threads.find((t) => t.id === THREAD_ID)
  const podiumSessionId = thread?.podiumSessionId

  // ---- per-section collapse + tray/chat split (engraved-column.md §2.7) ----
  const [trayOpen, setTrayOpenState] = useState(() => readSectionOpen(uiState.get(TRAY_OPEN_KEY)))
  const [chatOpen, setChatOpenState] = useState(() =>
    readSectionOpen(uiState.get(SUPER_CHAT_OPEN_KEY)),
  )
  const [trayHeight, setTrayHeightState] = useState<number | null>(() =>
    readTrayHeight(uiState.get(TRAY_HEIGHT_KEY)),
  )
  const setTrayOpen = (open: boolean): void => {
    setTrayOpenState(open)
    uiState.set(TRAY_OPEN_KEY, String(open))
  }
  const setChatOpen = (open: boolean): void => {
    setChatOpenState(open)
    uiState.set(SUPER_CHAT_OPEN_KEY, String(open))
  }

  const sectionRef = useRef<HTMLElement | null>(null)
  const trayBodyRef = useRef<HTMLDivElement | null>(null)
  const onSplitPointerDown = (down: ReactPointerEvent<HTMLDivElement>): void => {
    down.preventDefault()
    const startY = down.clientY
    const startHeight = trayBodyRef.current?.getBoundingClientRect().height ?? 0
    const columnHeight = sectionRef.current?.getBoundingClientRect().height ?? 0
    const max = Math.max(TRAY_MIN_HEIGHT, Math.round(columnHeight * TRAY_MAX_HEIGHT_RATIO))
    let latest = startHeight
    const move = (e: PointerEvent): void => {
      latest = Math.min(
        max,
        Math.max(TRAY_MIN_HEIGHT, Math.round(startHeight + e.clientY - startY)),
      )
      setTrayHeightState(latest)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      uiState.set(TRAY_HEIGHT_KEY, String(latest))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const feed = useIssueEvents(trpc, uiState, chatOpen, true)

  const refreshThreads = () =>
    trpc.superagent.listThreads
      .query()
      .then((t) => setThreads(t as SuperThread[]))
      .catch(() => {})

  // Legacy buffered history (read-only): pre-headless SuperMessage[] rows on the
  // global thread keep rendering as a collapsed block.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch after seeding/clear
  useEffect(() => {
    setLegacy([])
    setLegacyOpen(false)
    setError(null)
    trpc.superagent.history
      .query({ threadId: THREAD_ID })
      .then((h) => setLegacy(h as SuperMessage[]))
      .catch(() => {})
  }, [trpc, superRefreshKey])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch after seeding
  useEffect(() => {
    void refreshThreads()
  }, [trpc, superRefreshKey])

  // The thread learns its harnessSessionId when a turn ENDS — that id reveals
  // the "open in terminal" button, so refetch on turn end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshThreads is re-created each render
  useEffect(() => {
    if (!podiumSessionId) return
    return hub.subscribeHeadless?.(podiumSessionId, (event) => {
      if (event.kind === 'turn-end') void refreshThreads()
    })
  }, [hub, podiumSessionId])

  // "Open in terminal": focus the PTY session once its row lands in the
  // sessions broadcast (a fresh resume may beat the broadcast by a beat).
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null)
  useEffect(() => {
    if (!focusSessionId) return
    const s = sessions.find((x) => x.sessionId === focusSessionId)
    if (!s) return
    setFocusSessionId(null)
    // Clear the issue selection first: an issue workspace scopes its tab strip to
    // the issue's member sessions, so leaving it set showed the issue's (empty)
    // workspace instead of the superagent's PTY session — a blank middle pane.
    setSelectedIssueId(null)
    setSelectedWorktree(s.cwd)
    setPane('A', s.sessionId)
    setView('workspace')
  }, [focusSessionId, sessions, setSelectedWorktree, setSelectedIssueId, setPane, setView])

  const openInTerminal = async () => {
    setError(null)
    try {
      const r = await trpc.superagent.openInTerminal.mutate({ threadId: THREAD_ID })
      setFocusSessionId(r.sessionId)
      await refreshThreads()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Reset the thread's context: the server drops the harness session (the next
  // turn re-primes from the seed) and clears the legacy rows. A running turn or a
  // terminal lock refuses — surface that instead of silently doing nothing (#225).
  const clear = async () => {
    setError(null)
    try {
      await trpc.superagent.clear.mutate({ threadId: THREAD_ID })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    setLegacy([])
    void refreshThreads()
  }

  const selectedIssue = selectedIssueId
    ? issues.find((i) => i.id === selectedIssueId && !i.archived && !i.deletedAt)
    : undefined
  const itemCount = trayCount(issues, selectedIssueId ?? null)

  // ---- tray actions (v1 wiring — real backend verbs are #53/#54) ----
  const focusComposer = (): void => {
    requestAnimationFrame(() => {
      sectionRef.current
        ?.querySelector<HTMLTextAreaElement>('[data-superagent-composer] textarea')
        ?.focus()
    })
  }
  const prefillComposer = (text: string): void => {
    setChatOpen(true)
    if (podiumSessionId) setSessionDraft(podiumSessionId, text)
    else setPendingDraft(text)
    focusComposer()
  }
  const sendSuperTurn = async (text: string): Promise<void> => {
    setError(null)
    try {
      await trpc.superagent.sendTurn.mutate({ threadId: THREAD_ID, text, focus: getUserFocus() })
      setChatOpen(true)
      void refreshThreads()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const trayActions: TrayActions = {
    onMerge: (item: TrayItem) =>
      void sendSuperTurn(
        `Issue #${item.issue.seq} ("${item.issue.title}") is approved — merge it via the merge workflow and close the issue.`,
      ),
    onSendBack: (item: TrayItem) =>
      prefillComposer(`Send #${item.issue.seq} ("${item.issue.title}") back to its agent: `),
    onDiscuss: (item: TrayItem) =>
      prefillComposer(
        item.kind === 'question'
          ? `Re #${item.issue.seq} — the agent asked: "${item.text}". Answer: `
          : `Re #${item.issue.seq} ("${item.issue.title}"): `,
      ),
    onOpenSession: (item: TrayItem) => {
      const agentSession = (item.issue.sessions ?? []).find(
        (s) => !s.archived && s.agentKind !== 'shell' && s.headless !== true,
      )
      setSelectedIssueId(item.issue.id)
      if (agentSession) setPane('A', agentSession.sessionId)
      setView('workspace')
    },
    onResolve: (item: TrayItem) => {
      setError(null)
      trpc.issues.clearNeedsHuman
        .mutate({ id: item.issue.id })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    },
  }

  const ctxBadge = selectedIssue ? (
    <div
      data-testid="ctx-badge"
      className="flex items-center gap-2 pb-1.5 font-mono text-[9.5px] text-text-dim"
    >
      <span className="tracking-[.12em] text-text-faint">CTX</span>
      <IdSquare
        issue={selectedIssue}
        state="idle"
        onColorChange={(color) =>
          trpc.issues.update.mutate({ id: selectedIssue.id, patch: { color } })
        }
      />
      <span className="truncate">answering with #{selectedIssue.seq} context</span>
    </div>
  ) : null

  return (
    <section ref={sectionRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionBar
        testId="tray-bar"
        glyph="▤"
        title="Tray"
        scope={selectedIssue ? 'ISSUE SCOPE' : 'ALL ISSUES'}
        open={trayOpen}
        onToggle={() => setTrayOpen(!trayOpen)}
        badge={!trayOpen ? <CountPill count={itemCount} /> : undefined}
        className="border-b"
        actions={
          onClose ? (
            // Desktop folds the column; the mobile full-screen overlay minimizes
            // via the ⌄ in this bar instead (mobile.md §2.4).
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-5 flex-none text-muted-foreground"
              title={mobile ? 'Minimize' : 'Fold the tray and superagent column'}
              onClick={onClose}
            >
              {mobile ? (
                <ChevronDown size={14} aria-hidden="true" />
              ) : (
                <PanelRightClose size={13} aria-hidden="true" />
              )}
            </Button>
          ) : undefined
        }
      />
      {trayOpen && (
        <div
          ref={trayBodyRef}
          className={cn('min-h-0', chatOpen ? 'flex-none' : 'flex flex-1 flex-col overflow-y-auto')}
        >
          <Tray
            issues={issues}
            selectedIssueId={selectedIssueId ?? null}
            actions={trayActions}
            maxHeight={chatOpen ? trayHeight : null}
          />
        </div>
      )}
      {trayOpen && chatOpen && (
        // biome-ignore lint/a11y/useSemanticElements: the drag handle is an interactive separator, not a thematic break
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="Resize tray"
          aria-valuemin={TRAY_MIN_HEIGHT}
          aria-valuenow={trayHeight ?? TRAY_MIN_HEIGHT}
          className="h-[5px] flex-none cursor-row-resize hover:bg-[rgba(245,158,11,.15)]"
          onPointerDown={onSplitPointerDown}
        />
      )}
      {!trayOpen && !chatOpen && <div className="flex-1" aria-hidden="true" />}
      <SectionBar
        testId="super-bar"
        glyph="✦"
        title="Super agent"
        scope="OVERARCHING · KNOWS THIS ISSUE"
        open={chatOpen}
        onToggle={() => setChatOpen(!chatOpen)}
        badge={!chatOpen ? <UnreadDot show={feed.unread} /> : undefined}
        shadow={chatOpen}
        className={chatOpen ? 'border-y' : 'border-t'}
        actions={
          <>
            {thread?.harnessSessionId && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-5 flex-none text-muted-foreground"
                title="Open this conversation in a terminal session"
                onClick={() => void openInTerminal()}
              >
                <SquareTerminal size={12} aria-hidden="true" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-5 flex-none text-muted-foreground"
              title="Clear the conversation"
              onClick={() => void clear()}
            >
              <Eraser size={12} aria-hidden="true" />
            </Button>
          </>
        }
      />
      {chatOpen && (
        <>
          {error && (
            <div className="flex-none border-b border-hairline-soft px-[18px] py-2 text-[12px] text-destructive">
              {error}
            </div>
          )}
          <EventFeed
            events={feed.events}
            issues={issues}
            selectedIssueId={selectedIssueId ?? null}
            dividerId={feed.dividerId}
            dividerTs={feed.dividerTs}
            onSelectIssue={(issueId) => setSelectedIssueId(issueId)}
          />
          {legacy.length > 0 && (
            <div className="flex-none border-b border-hairline-soft px-[18px] py-2">
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
            <div data-superagent-composer className="flex min-h-0 flex-1 flex-col">
              <ChatView
                sessionId={podiumSessionId}
                active
                superThread={{ threadId: THREAD_ID, kind: 'global' }}
                compact
                ctxBadge={ctxBadge}
              />
            </div>
          ) : (
            <div data-superagent-composer className="flex min-h-0 flex-1 flex-col">
              <FreshThreadComposer
                key={pendingDraft || THREAD_ID}
                threadId={THREAD_ID}
                initialDraft={pendingDraft}
                ctxBadge={ctxBadge}
                onError={setError}
                onSent={() => void refreshThreads()}
              />
            </div>
          )}
        </>
      )}
    </section>
  )
}

/**
 * The pre-session state of the global thread: hint copy + a composer with
 * @-mentions and voice input. The FIRST send runs the turn; the ack's
 * podiumSessionId flows back via listThreads and the parent swaps this
 * composer for the embedded ChatView. The just-sent text stays visible as an
 * optimistic bubble until the swap.
 */
function FreshThreadComposer({
  threadId,
  initialDraft = '',
  ctxBadge,
  onError,
  onSent,
}: {
  threadId: string
  initialDraft?: string
  ctxBadge?: JSX.Element | null
  onError: (message: string | null) => void
  onSent: () => void
}): JSX.Element {
  const { trpc, repos, getUserFocus } = useStoreSelector(
    (s) => ({ trpc: s.trpc, repos: s.repos, getUserFocus: s.getUserFocus }),
    shallowEqual,
  )
  const [draft, setDraft] = useState(initialDraft)
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
      await trpc.superagent.sendTurn.mutate({ threadId, text, focus: getUserFocus() })
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
        {sentText === null && (
          <div className="mx-auto my-6 max-w-[46ch] text-center text-[13px] text-muted-foreground/70">
            Your orchestrator. Ask it to start agents, set up worktrees, dig through past
            conversations, or work tickets. Type{' '}
            <code className="rounded-sm bg-background px-[3px] font-mono text-[0.92em]">@</code> to
            reference a repo, worktree, or conversation.
          </div>
        )}
        {sentText !== null && (
          <>
            <div className="mx-auto w-full max-w-[960px] rounded-[10px] border border-border bg-secondary px-3.5 py-2.5">
              <div className="mb-[3px] text-[10px] uppercase tracking-[0.07em] text-muted-foreground/70">
                You
              </div>
              <div className="chat-md whitespace-pre-wrap">{sentText}</div>
            </div>
            <div className="mx-auto w-full max-w-[960px] animate-pulse text-xs text-muted-foreground/70">
              Starting the conversation…
            </div>
          </>
        )}
      </div>
      <div className="flex-none border-t border-hairline-soft px-3.5 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom,0px))] font-mono">
        {ctxBadge}
        <div className="relative flex items-end gap-2 rounded-lg border border-[#3a3a46] bg-[rgba(8,8,12,.7)] px-3 py-1.5 transition-colors focus-within:border-primary">
          {atQuery !== null && atHits.length > 0 && (
            <div
              className="absolute right-0 bottom-[calc(100%+10px)] left-0 z-30 flex max-w-[460px] flex-col overflow-hidden rounded-md border border-input bg-muted font-sans shadow-[0_-8px_24px_rgb(0_0_0_/_0.4)]"
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
          <span
            className="flex-none pt-[3px] text-[13px] leading-[1.45] text-[#6c6c78]"
            aria-hidden="true"
          >
            &gt;
          </span>
          <BlockCaret taRef={inputRef} value={draft} />
          <Textarea
            ref={inputRef}
            className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-0 text-[13px] leading-[1.45] text-foreground caret-transparent shadow-none field-sizing-fixed placeholder:text-[#4d4d59] focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder="Ask about anything — @ to pull other issues into context"
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
          {voice.supported && (
            <button
              type="button"
              className={cn(
                'flex size-6 flex-none items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors hover:text-foreground',
                voice.listening && 'animate-pulse text-destructive',
              )}
              title={voice.listening ? 'Stop voice input' : 'Voice input'}
              onClick={voice.toggle}
            >
              <Mic size={14} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="flex size-6 flex-none items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-40"
            disabled={busy || !draft.trim()}
            title="Send"
            onClick={() => void send()}
          >
            <Send size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="flex items-center gap-2 px-1 pt-1.5 text-[10.5px] text-[#4d4d59]">
          <span className="text-[#6c6c78]">⏵⏵ auto-delegate on</span>
          <span>(shift+tab to cycle)</span>
          <span className="ml-auto">? for shortcuts</span>
        </div>
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
  const { sessions, setPane, setSelectedWorktree, setView, hub } = useStoreSelector(
    (s) => ({
      sessions: s.sessions,
      setPane: s.setPane,
      setSelectedWorktree: s.setSelectedWorktree,
      setView: s.setView,
      hub: s.hub,
    }),
    shallowEqual,
  )
  const [following, setFollowing] = useState(false)
  const session = sessions.find((s) => s.sessionId === sessionId)
  const status = session ? (agentBadge(session)?.label ?? session.status) : 'starting…'
  const open = () => {
    setSelectedWorktree(cwd)
    setPane('A', sessionId)
    setView('workspace')
  }
  return (
    <div className="mx-auto w-full max-w-[960px] overflow-hidden rounded-[10px] border border-border bg-background">
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
        <span className="flex-none text-[11px] text-muted-foreground">{status}</span>
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
  hub: Store['hub']
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
      <div className="mx-auto w-full max-w-[960px]">
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
      <div className="mx-auto w-full max-w-[960px]">
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
        'mx-auto w-full max-w-[960px]',
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
