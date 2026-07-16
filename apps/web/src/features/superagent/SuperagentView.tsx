import { shallowEqual } from '@podium/client-core/store'
import { ChevronDown, Eraser, Mic, PanelRightClose, Send, SquareTerminal } from 'lucide-react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ChatView } from '@/features/chat/ChatView'
import { BlockCaret } from '@/lib/BlockCaret'
import { reposToViews } from '@/lib/derive'
import { useConversationSearch } from '@/lib/useConversationSearch'
import { cn } from '@/lib/utils'
import { useVoiceInput } from '@/lib/voice'
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

  return (
    <section ref={sectionRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionBar
        testId="tray-bar"
        glyph="▤"
        title="Tray"
        scope={selectedIssue ? 'TASK SCOPE' : 'ALL TASKS'}
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
          {podiumSessionId ? (
            <div data-superagent-composer className="flex min-h-0 flex-1 flex-col">
              <ChatView
                sessionId={podiumSessionId}
                active
                superThread={{ threadId: THREAD_ID, kind: 'global' }}
                compact
              />
            </div>
          ) : (
            <div data-superagent-composer className="flex min-h-0 flex-1 flex-col">
              <FreshThreadComposer
                key={pendingDraft || THREAD_ID}
                threadId={THREAD_ID}
                initialDraft={pendingDraft}
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
  onError,
  onSent,
}: {
  threadId: string
  initialDraft?: string
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
            placeholder="Ask about anything — @ to pull other tasks into context"
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
