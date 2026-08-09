import { shallowEqual } from '@podium/client-core/store'
import { reposToViews, superagentSlice } from '@podium/client-core/viewmodels'
import { useVoiceInput } from '@podium/terminal-client-react'
import { ArrowUp, Eraser, Mic, SquareTerminal } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DockHeaderActions } from '@/app/DockHeaderSlot'
import { useReplicaIssues, useSlice, useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ChatView } from '@/features/chat/ChatView'
import { AtMentionMenu } from '@/lib/at-mention/AtMentionMenu'
import type { AtOption } from '@/lib/at-mention/at-mention'
import { issueMentions } from '@/lib/at-mention/mention-sources'
import { useAtMenu, useAtTrigger } from '@/lib/at-mention/useAtMention'
import { BrailleSpinner } from '@/lib/motion'
import { usePromptAutoGrow } from '@/lib/use-prompt-auto-grow'
import { useConversationSearch } from '@/lib/useConversationSearch'
import { cn } from '@/lib/utils'
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

/** The pane's quiet icon actions, worn by the dock title bar: 20×20, --text-dim
 *  at rest, hover --text-strong on the raised --chip tier, 5px radius. */
const BAR_ACTION_CLS =
  'size-5 flex-none rounded-[5px] text-text-dim hover:bg-chip hover:text-text-strong'

/** The prompt box's inline actions: 24px square — exactly one 24px text row, so
 *  the resting composer has no seam between its glyph column and its text. */
const ACTION_CLS =
  'flex size-6 flex-none items-center justify-center rounded-[6px] border-0 transition-colors duration-150 disabled:cursor-default motion-reduce:transition-none'

/**
 * The Superagent dock pane — the portfolio copilot, and NOTHING else.
 *
 * It is TWO things (POD-516 §1.2): the dock-top (owned by `RightDock`, the
 * pane's only chrome and its ONE header — this pane lends it two icon actions
 * and renders no header of its own), and the one global conversation with its
 * composer.
 *
 * It used to open with a "Current focus" line naming the selected mission.
 * That line is gone (operator, round 3: "no need to list the focus it has,
 * remove that"). It was reporting a fact the operator had just performed —
 * they selected the task, so the sidebar row, the ID square in the rail and the
 * tab strip are all already saying which one — and it was saying it in the one
 * place where it was also slightly untrue: the thread is global, the selection
 * only rides the turn's focus payload. That capability is untouched; only the
 * caption is gone.
 *
 * The Tray used to sit above the chat here, with a second collapsible section
 * bar and a drag separator between them. It is gone: web attention now reads
 * off the Flight Deck and the rail badge. `deriveTrayItems` survives in
 * client-core because apps/mobile still has a Tray screen.
 */
export function SuperagentView(): JSX.Element {
  const {
    hub,
    trpc,
    sessions,
    refreshSuperThreads,
    setPane,
    setSelectedWorktree,
    setSelectedIssueId,
    setView,
    readPosition,
  } = useStoreSelector(
    (s) => ({
      hub: s.hub,
      trpc: s.trpc,
      sessions: s.sessions,
      refreshSuperThreads: s.refreshSuperThreads,
      setPane: s.setPane,
      setSelectedWorktree: s.setSelectedWorktree,
      setSelectedIssueId: s.setSelectedIssueId,
      setView: s.setView,
      readPosition: s.readPosition,
    }),
    shallowEqual,
  )
  const [error, setError] = useState<string | null>(null)
  const [pendingFirstTurn, setPendingFirstTurn] = useState<string | null>(null)
  // POD-330 (audit item zero): the thread list is STORE state. The view used to
  // declare its own SuperThread type, hold the list in useState, fetch it from
  // tRPC itself and be poked to refetch by a `superRefreshKey` counter that
  // actions bumped from across the app. One published slice replaces all four.
  const { active: thread } = useSlice(superagentSlice)
  const podiumSessionId = thread?.podiumSessionId

  // The pane is one surface now — no sections, so no per-section collapse and
  // no split handle. The dock-top's close chevron is the only fold left, and
  // the shell owns it.
  const feed = useIssueEvents(trpc, readPosition, true, true)

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

  return (
    <section data-testid="superagent-pane" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The pane's two controls, in the dock title bar. There is ONE header
          (POD-516 item 10): "Superagent" already names this surface, so a
          "Portfolio copilot" heading under it was the same name twice. */}
      <DockHeaderActions>
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
      </DockHeaderActions>
      {/* Nothing stands between the dock title and the conversation. The
          subtitle went with the heading, and the focus line went with round 3 —
          what this box's scope is, the composer's own placeholder says, at the
          moment the operator is about to use it. */}
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
        // Same `data-prompt-bounds` as the fresh-thread branch below: once the
        // thread starts, the in-thread composer is the same box and caps against
        // the same pane. Without it the cap falls back to the line count alone
        // and a short dock can end up mostly composer.
        <div data-superagent-composer data-prompt-bounds className="flex min-h-0 flex-1 flex-col">
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
        // `data-prompt-bounds` is the surface the composer measures itself
        // against: its cap is a share of THIS box, so a short dock never ends
        // up mostly composer (usePromptAutoGrow).
        <div data-superagent-composer data-prompt-bounds className="flex min-h-0 flex-1 flex-col">
          <FreshThreadComposer
            threadId={THREAD_ID}
            onError={setError}
            onSent={(text) => {
              setPendingFirstTurn(text)
              void refreshThreads()
            }}
          />
        </div>
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
  onError,
  onSent,
}: {
  threadId: string
  onError: (message: string | null) => void
  onSent: (text: string) => void
}): JSX.Element {
  const { trpc, repos, getUserFocus } = useStoreSelector(
    (s) => ({ trpc: s.trpc, repos: s.repos, getUserFocus: s.getUserFocus }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [sentText, setSentText] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const voice = useVoiceInput((text) => setDraft((d) => (d ? `${d} ${text}` : text)))

  // One line at rest, a line at a time as the prompt wraps, capped at eight
  // lines or 42% of the pane — whichever comes first — after which it scrolls
  // inside. All of it in `usePromptAutoGrow`, which the chat composer's own
  // copy of this measurement is meant to fold into next.
  usePromptAutoGrow({ taRef: inputRef, value: draft })

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

  /** There is something to send, and nothing already going. */
  const armed = !busy && draft.trim().length > 0

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
          <div className="shell-type-primary mx-auto my-6 max-w-[46ch] text-center text-muted-foreground">
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
            {/* The one signal for "an agent is computing" is the braille spinner
                in its working blue (DESIGN.md §5 Agent State Grammar). This line
                used to breathe on `animate-pulse`, which the same rule forbids —
                a pulse is decoration and it competes with the real signal. */}
            <div
              role="status"
              aria-live="polite"
              className="shell-type-micro mx-auto flex w-full max-w-[960px] items-center gap-2 text-muted-foreground"
            >
              <BrailleSpinner size={10} className="text-live" />
              Starting the conversation…
            </div>
          </>
        )}
      </div>
      {/* THE PROMPT BOX. No top seam and no full-bleed bar: it is inset from all
          four edges and the thread dissolves into the ground above it, so it
          reads as an object sitting ON the conversation. Its separation is
          carved, not floated — `.prompt-well` grooves it into the pane with the
          same --well-* bevel the command bar's wells use (styles.css). */}
      <div className="prompt-dock font-mono" data-testid="super-composer">
        <div className="prompt-well">
          <AtMentionMenu mention={mention} hint="↑↓ to move · ↵ to insert · esc to dismiss" />
          <Textarea
            ref={inputRef}
            className="prompt-input shell-type-primary min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-0 text-foreground caret-foreground shadow-none field-sizing-fixed placeholder:text-text-dim focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            rows={1}
            // With the focus line gone this is the only statement of the box's
            // scope, so it names it rather than saying "Message…".
            placeholder="Ask across all tasks…"
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
          {/* The actions sit on the LAST line as the box grows (`self-end`), and
              at one line the 24px cell is exactly the 24px text row, so nothing
              shifts between the resting state and the first wrap. */}
          <div className="flex flex-none items-center gap-0.5 self-end">
            {voice.supported && (
              <button
                data-pressable
                type="button"
                className={cn(
                  ACTION_CLS,
                  'text-text-dim hover:bg-chip hover:text-text-strong',
                  // Listening is a live state, so it reads in the live blue and
                  // holds STILL: DESIGN.md's motion grammar spends perpetual
                  // motion only on an agent actually computing, and the old
                  // `animate-pulse text-destructive` broke both halves of it.
                  voice.listening && 'bg-chip text-live',
                )}
                title={voice.listening ? 'Stop voice input' : 'Voice input'}
                onClick={voice.toggle}
              >
                <Mic size={14} aria-hidden="true" />
              </button>
            )}
            {/* THE ARMED SEND. Empty, it is a quiet glyph that is still legible
                without hovering (dim ink, not 40% opacity). The moment there is
                something to send it fills Superade Yellow over 150ms — this is
                the primary action, which is the one thing The Signal Rule buys
                yellow for. */}
            <button
              data-pressable
              type="button"
              className={cn(
                ACTION_CLS,
                armed
                  ? 'bg-primary text-primary-foreground hover:bg-primary/80'
                  : 'bg-transparent text-text-dim',
              )}
              disabled={!armed}
              title="Send (Enter · shift+Enter for a newline)"
              aria-label="Send"
              onClick={() => void send()}
            >
              <ArrowUp size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
