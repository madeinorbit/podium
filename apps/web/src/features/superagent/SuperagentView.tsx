import { randomUUID } from '@podium/client-core/id'
import { shallowEqual } from '@podium/client-core/store'
import type { TrayItem } from '@podium/client-core/viewmodels'
import { offerKey, reposToViews, superagentSlice, trayCount } from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model'
import { useVoiceInput } from '@podium/terminal-client-react'
import { ChevronDown, Eraser, Mic, PanelRightClose, Send, SquareTerminal } from 'lucide-react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useReplicaIssues, useSlice, useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ChatView } from '@/features/chat/ChatView'
import { AtMentionMenu } from '@/lib/at-mention/AtMentionMenu'
import type { AtOption } from '@/lib/at-mention/at-mention'
import { issueMentions } from '@/lib/at-mention/mention-sources'
import { useAtMenu, useAtTrigger } from '@/lib/at-mention/useAtMention'
import { BlockCaret } from '@/lib/BlockCaret'
import { useConversationSearch } from '@/lib/useConversationSearch'
import { cn } from '@/lib/utils'
import {
  readSectionOpen,
  readTrayHeight,
  SUPER_CHAT_OPEN_KEY,
  TRAY_HEIGHT_KEY,
  TRAY_MAX_HEIGHT_RATIO,
  TRAY_MIN_HEIGHT,
  TRAY_OPEN_KEY,
} from './column-state'
import { CountPill, SectionBar, UnreadDot } from './SectionBar'
import { Tray } from './Tray'
import type { TrayActions } from './TrayCard'
import { useIssueEvents } from './useIssueEvents'

/** ONE chat across all issues (engraved-column.md §2.5): the column always
 *  binds the global thread; per-turn issue context rides the focus payload.
 *  Per-repo concierge / btw thread history access is #55. */
const THREAD_ID = 'global'

const clock = (ts: string): string => {
  const d = new Date(ts)
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** §2.2 super agent bar icon actions: 20×20, --text-dim at rest,
 *  hover --text-strong on the raised --chip tier, 5px radius. */
const BAR_ACTION_CLS =
  'size-5 flex-none rounded-[5px] text-text-dim hover:bg-chip hover:text-text-strong'

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
    selectedIssueId,
    superThreads,
    refreshSuperThreads,
    setPane,
    setSelectedWorktree,
    setSelectedIssueId,
    setView,
    uiState,
    readPosition,
    setSessionDraft,
  } = useStoreSelector(
    (s) => ({
      hub: s.hub,
      trpc: s.trpc,
      sessions: s.sessions,
      selectedIssueId: s.selectedIssueId,
      superThreads: s.superThreads,
      refreshSuperThreads: s.refreshSuperThreads,
      setPane: s.setPane,
      setSelectedWorktree: s.setSelectedWorktree,
      setSelectedIssueId: s.setSelectedIssueId,
      setView: s.setView,
      uiState: s.uiState,
      readPosition: s.readPosition,
      setSessionDraft: s.setSessionDraft,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const [error, setError] = useState<string | null>(null)
  const [pendingDraft, setPendingDraft] = useState('')
  const [pendingFirstTurn, setPendingFirstTurn] = useState<string | null>(null)
  // POD-330 (audit item zero): the thread list is STORE state. The view used to
  // declare its own SuperThread type, hold the list in useState, fetch it from
  // tRPC itself and be poked to refetch by a `superRefreshKey` counter that
  // actions bumped from across the app. One published slice replaces all four.
  const { threads, active: thread } = useSlice(superagentSlice)
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

  const feed = useIssueEvents(trpc, readPosition, mobile || chatOpen, true)

  const refreshThreads = () => refreshSuperThreads().catch(() => {})

  // The thread learns its harnessSessionId when a turn ENDS — that id reveals
  // the "open in terminal" button, so refetch on turn end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshThreads is re-created each render
  useEffect(() => {
    if (!podiumSessionId) return
    return hub.subscribeHeadless?.(podiumSessionId, (event) => {
      if (event.kind === 'turn-end') void refreshThreads()
    })
  }, [hub, podiumSessionId, refreshSuperThreads])

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

  // Agent action offers [spec:SP-c7f1]: a clicked offer hides optimistically
  // until the server clears it off the session meta (mirrors ChatView's
  // dismissedOfferAt). Keyed by offerKey so a NEW offer re-shows.
  const [dismissedOffers, setDismissedOffers] = useState<ReadonlySet<string>>(new Set())
  const itemCount = trayCount(issues, sessions, dismissedOffers)
  // The amber count pill pops exactly when the count INCREASES (motion.md
  // §2.2) — decreases and steady renders stay still.
  const prevCountRef = useRef(itemCount)
  const pillPop = itemCount > prevCountRef.current
  useEffect(() => {
    prevCountRef.current = itemCount
  })

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
  const trayActions: TrayActions = {
    onDiscuss: (item: TrayItem) =>
      prefillComposer(
        item.kind === 'question'
          ? `Re #${item.issue.seq} — the agent asked: "${item.text}". Answer: `
          : `Re #${item.issue.seq} ("${item.issue.title}"): `,
      ),
    onOpenSession: (item: TrayItem) => {
      // An offer card names its exact session; question cards fall back to the
      // issue's first live agent session.
      const memberIds = new Set(item.issue.memberSessionIds ?? [])
      const agentSession =
        item.kind === 'offer'
          ? item.session
          : sessions.find(
              (s) =>
                memberIds.has(s.sessionId) &&
                !s.archived &&
                s.agentKind !== 'shell' &&
                s.headless !== true,
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
    // Offer button [spec:SP-c7f1]: send the agent-authored prompt to the
    // offer's OWN session as a normal user turn — the same sendText path the
    // chat/native offer bars use, so the server auto-clears the offer. Hide
    // the card optimistically; un-hide on failure so it can be retried.
    onOfferAction: (item, prompt) => {
      const key = offerKey(item.session.sessionId, item.offer.createdAt)
      setError(null)
      setDismissedOffers((d) => new Set(d).add(key))
      trpc.sessions.sendText
        .mutate({ sessionId: item.session.sessionId, text: prompt, mutationId: randomUUID() })
        .catch((e: unknown) => {
          setDismissedOffers((d) => {
            const next = new Set(d)
            next.delete(key)
            return next
          })
          setError(e instanceof Error ? e.message : String(e))
        })
    },
  }

  return (
    <section ref={sectionRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!mobile && (
        <>
          <SectionBar
            testId="tray-bar"
            glyph="▤"
            title="Tray"
            scope="ALL TASKS · NEWEST FIRST"
            open={trayOpen}
            onToggle={() => setTrayOpen(!trayOpen)}
            badge={
              // The pill rides the bar open OR collapsed (mock v3) — the
              // "needs you" count never disappears with the section.
              itemCount > 0 ? (
                <span key={itemCount} className={cn('flex', pillPop && 'morph-pop')}>
                  <CountPill count={itemCount} />
                </span>
              ) : undefined
            }
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
              // Chat folded: the tray owns the rest of the column and is the
              // only scroller in it. This wrapper must NOT scroll too — a
              // second scroll container here swallowed the wheel and left the
              // card stack capped at its split height (POD-288).
              className={cn('min-h-0', chatOpen ? 'flex-none' : 'flex flex-1 flex-col')}
            >
              <Tray
                issues={issues}
                sessions={sessions}
                selectedIssueId={selectedIssueId ?? null}
                actions={trayActions}
                maxHeight={chatOpen ? trayHeight : null}
                fill={!chatOpen}
                dismissedOffers={dismissedOffers}
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
              className="h-[5px] flex-none cursor-row-resize hover:bg-attention/15"
              onPointerDown={onSplitPointerDown}
            />
          )}
          {!trayOpen && !chatOpen && <div className="flex-1" aria-hidden="true" />}
        </>
      )}
      <SectionBar
        testId="super-bar"
        glyph="✦"
        title="Super agent"
        scope="OVERARCHING · KNOWS THIS ISSUE"
        open={mobile || chatOpen}
        onToggle={() => {
          if (!mobile) setChatOpen(!chatOpen)
        }}
        badge={!chatOpen ? <UnreadDot show={feed.unread} /> : undefined}
        shadow={chatOpen}
        className={chatOpen ? 'border-y' : 'border-t'}
        actions={
          <>
            {mobile && onClose && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-5 flex-none text-muted-foreground"
                title="Minimize"
                onClick={onClose}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </Button>
            )}
            {thread?.harnessSessionId && (
              <Button
                variant="ghost"
                size="icon-sm"
                className={BAR_ACTION_CLS}
                title="Open this conversation in a terminal session"
                onClick={() => void openInTerminal()}
              >
                <SquareTerminal size={12} aria-hidden="true" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className={BAR_ACTION_CLS}
              title="Clear context — start the global chat fresh"
              onClick={() => void clear()}
            >
              <Eraser size={12} aria-hidden="true" />
            </Button>
          </>
        }
      />
      {(mobile || chatOpen) && (
        <>
          {error && (
            <div
              role="alert"
              className="flex-none border-b border-hairline-soft px-[18px] py-2 text-[12px] leading-5 text-destructive"
            >
              {error}
            </div>
          )}
          {/* POD-113: the standing event feed is gone — the chat owns the space
              and "what happened" is a super-agent question. Only the frozen
              YOU-WERE-HERE return marker survives, pinned atop the chat. */}
          {feed.dividerId > 0 && feed.events.some((e) => e.id > feed.dividerId) && (
            <div
              data-testid="you-were-here"
              className="flex flex-none items-center gap-2 px-3.5 pt-2 pb-0.5 font-mono text-[9px] tracking-[.08em] text-attention"
            >
              <span className="h-px flex-1 bg-attention/40" />
              YOU WERE HERE{feed.dividerTs ? ` · ${clock(feed.dividerTs)}` : ''}
              <span className="h-px flex-1 bg-attention/40" />
            </div>
          )}
          {podiumSessionId ? (
            <div data-superagent-composer className="flex min-h-0 flex-1 flex-col">
              <ChatView
                sessionId={podiumSessionId}
                active
                superThread={{ threadId: THREAD_ID, kind: 'global' }}
                compact
                initialTurnRunning={thread?.turnRunning === true}
                initialPendingText={pendingFirstTurn ?? undefined}
              />
            </div>
          ) : (
            <div data-superagent-composer className="flex min-h-0 flex-1 flex-col">
              <FreshThreadComposer
                key={pendingDraft || THREAD_ID}
                threadId={THREAD_ID}
                initialDraft={pendingDraft}
                onError={setError}
                onSent={(text) => {
                  setPendingFirstTurn(text)
                  void refreshThreads()
                }}
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
 *
 * THE @ MENU LIVES IN `@/lib/at-mention` NOW (POD-412). It was written here and
 * this composer was its only mount; the chat composer needed the same thing, so
 * the mechanism moved out and both surfaces mount it. What stays here is the one
 * thing that is genuinely this composer's: WHAT it offers — the orchestrator's
 * own vocabulary of repos, worktrees and past conversations, plus the issues it
 * spends its day working.
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
  onSent: (text: string) => void
}): JSX.Element {
  const { trpc, repos, getUserFocus } = useStoreSelector(
    (s) => ({ trpc: s.trpc, repos: s.repos, getUserFocus: s.getUserFocus }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const [draft, setDraft] = useState(initialDraft)
  const [busy, setBusy] = useState(false)
  const [sentText, setSentText] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const voice = useVoiceInput((text) => setDraft((d) => (d ? `${d} ${text}` : text)))

  // Auto-grow the composer with its content like the native-agent one, capped
  // at ~6 lines after which it scrolls. Measured at height:auto, then set as an
  // explicit px height so the CSS height transition animates grow/shrink (the
  // momentary auto never paints).
  useEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    // Measure at auto, restore the previous height, reflow, then set the
    // target — otherwise the transition starts from 'auto' (uninterpolable)
    // and snaps instead of animating. When empty, scrollHeight includes the
    // (possibly wrapped) placeholder — size to one line instead.
    const prev = ta.style.height
    ta.style.height = 'auto'
    const cs = getComputedStyle(ta)
    const oneLine =
      Number.parseFloat(cs.lineHeight) +
      Number.parseFloat(cs.paddingTop) +
      Number.parseFloat(cs.paddingBottom)
    const target = ta.value ? Math.min(ta.scrollHeight, 114) : oneLine
    ta.style.height = prev || `${target}px`
    void ta.offsetHeight
    ta.style.height = `${target}px`
  }, [draft])

  // ---- @ context: repos, worktrees, past conversations, issues ----
  // The orchestrator's token stays `@label(path)`: it is what the seed prompt
  // tells the agent to expect, and a picker is not the place to renegotiate a
  // protocol. Issue rows insert a bare ref like everywhere else.
  const trigger = useAtTrigger({ taRef: inputRef })
  const localAtOptions = useMemo<AtOption[]>(() => {
    const views = reposToViews(repos)
    const out: AtOption[] = []
    for (const repo of views) {
      out.push({
        kind: 'repo',
        id: `repo:${repo.path}`,
        label: repo.name,
        detail: repo.path,
        insert: `@${repo.name}(${repo.path})`,
      })
      for (const wt of repo.worktrees) {
        if (wt.isMain) continue
        const label = `${repo.name}/${wt.branch ?? wt.path.split('/').pop()}`
        out.push({
          kind: 'worktree',
          id: `worktree:${wt.path}`,
          label,
          detail: wt.path,
          insert: `@${label}(${wt.path})`,
        })
      }
    }
    return out
  }, [repos])

  const { hits: convHits } = useConversationSearch({
    query: trigger.query ?? '',
    limit: 4,
    enabled: trigger.query !== null,
    debounceMs: 150,
  })
  const atOptions = useMemo<AtOption[]>(() => {
    const q = trigger.query
    if (q === null) return []
    const needle = q.toLowerCase()
    const local = localAtOptions
      .filter(
        (o) => o.label.toLowerCase().includes(needle) || o.detail.toLowerCase().includes(needle),
      )
      .slice(0, 6)
    const convs = convHits.map((hit): AtOption => {
      const label = hit.name || hit.title || hit.id
      return {
        kind: 'conversation',
        id: `conversation:${hit.id}`,
        label,
        detail: hit.projectPath?.split('/').slice(-2).join('/') ?? '',
        insert: `@${label}(conversation:${hit.id})`,
      }
    })
    return [...local, ...issueMentions(issues, q, 4), ...convs].slice(0, 10)
  }, [trigger.query, localAtOptions, convHits, issues])

  const mention = useAtMenu({
    trigger,
    taRef: inputRef,
    value: draft,
    onChange: setDraft,
    options: atOptions,
  })

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    trigger.close()
    setBusy(true)
    setSentText(text)
    onError(null)
    try {
      await trpc.superagent.sendTurn.mutate({
        threadId,
        text,
        focus: getUserFocus(),
      })
      // The ack minted the headless session — refresh the thread list so the
      // parent swaps to the embedded ChatView (the bubble carries over there
      // via the transcript itself).
      onSent(text)
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
            reference a repo, worktree, task or past conversation.
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
            <div
              role="status"
              aria-live="polite"
              className="mx-auto w-full max-w-[960px] animate-pulse text-xs text-muted-foreground/70"
            >
              Starting the conversation…
            </div>
          </>
        )}
      </div>
      <div className="flex-none border-t border-hairline-soft px-3.5 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom,0px))] font-mono">
        <div className="relative flex items-end gap-2 rounded-lg border border-border-strong bg-bar/70 px-3 py-1.5 transition-colors focus-within:border-primary">
          <AtMentionMenu mention={mention} hint="↑↓ to move · ↵ to insert · esc to dismiss" />
          <span
            className="flex-none pt-[3px] text-[13px] leading-[1.45] text-text-dim"
            aria-hidden="true"
          >
            &gt;
          </span>
          <BlockCaret taRef={inputRef} value={draft} />
          <Textarea
            ref={inputRef}
            className="min-h-0 flex-1 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 text-[13px] leading-[1.45] text-foreground caret-transparent shadow-none field-sizing-fixed transition-[height] duration-300 ease-[cubic-bezier(0.25,1,0.35,1)] placeholder:text-text-faint focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            rows={1}
            placeholder="Ask anything — @ to add context"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              trigger.sync()
            }}
            onSelect={trigger.sync}
            onKeyDown={(e) => {
              if (mention.onKeyDown(e)) return
              // Let an IME candidate confirm itself: some browsers clear
              // isComposing on the confirming Enter but still report the legacy
              // keyCode, so both are checked (as the chat composer does).
              if (
                e.key === 'Enter' &&
                (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
              ) {
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          {voice.supported && (
            <button
              data-pressable
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
            data-pressable
            type="button"
            className="flex size-6 flex-none items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-40"
            disabled={busy || !draft.trim()}
            title="Send"
            onClick={() => void send()}
          >
            <Send size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="flex items-center gap-2 px-1 pt-1.5 text-[10.5px] text-text-faint">
          <span className="text-text-dim">⏵⏵ auto-delegate on</span>
          <span>(shift+tab to cycle)</span>
          <span className="ml-auto">? for shortcuts</span>
        </div>
      </div>
    </>
  )
}
