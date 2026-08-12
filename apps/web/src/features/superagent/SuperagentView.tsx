import { shallowEqual } from '@podium/client-core/store'
import { superagentSlice } from '@podium/client-core/viewmodels'
import { Eraser, SquareTerminal } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { DockHeaderActions } from '@/app/DockHeaderSlot'
import { useSlice, useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { ChatView } from '@/features/chat/ChatView'
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

/**
 * The Superagent dock pane — the portfolio copilot, and NOTHING else.
 *
 * It is TWO things (POD-516 §1.2): the dock-top (owned by `RightDock`, the
 * pane's only chrome and its ONE header — this pane lends it two icon actions
 * and renders no header of its own), and the one global conversation with its
 * composer.
 *
 * ---------------------------------------------------------------------------
 * ONE CHAT, ONE COMPOSER, FROM THE FIRST FRAME (POD-782)
 * ---------------------------------------------------------------------------
 *
 * This file used to be 500 lines because it carried a SECOND composer —
 * `FreshThreadComposer`, ~240 lines — for the state before a thread had run its
 * first turn. It had to exist because a thread had no headless session until its
 * first message landed, and `ChatView` needs a session to render against.
 *
 * That second box drifted, as a second implementation of one thing always does:
 * no attachments, no offer bar, no queue notice, no stop button, its own
 * @-mention wiring, its own optimistic bubble, its own send path. Whichever of
 * the two boxes you were looking at, you were looking at the wrong one half the
 * time — and every chat fix had to be made twice or be silently half-applied.
 *
 * `superagent.ensureSession` removes the reason for it: the thread gets its
 * (process-less, PTY-less) headless session up front, so this pane mounts the
 * ordinary `ChatView` immediately and the superagent's chat IS the chat — same
 * feed, same blocks, same composer, same keyboard contract. What is still this
 * surface's own is `compact`, which is not a size knob but *which product
 * surface this is*: no reading rail, no find, the mono prompt well.
 *
 * The empty thread is no longer a different screen; it is this screen with an
 * empty transcript, which `TranscriptStandby` already knows how to say.
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
  // POD-330 (audit item zero): the thread list is STORE state. The view used to
  // declare its own SuperThread type, hold the list in useState, fetch it from
  // tRPC itself and be poked to refetch by a `superRefreshKey` counter that
  // actions bumped from across the app. One published slice replaces all four.
  const { active: thread } = useSlice(superagentSlice)
  const podiumSessionId = thread?.podiumSessionId

  // The pane is one surface now — no sections, so no per-section collapse and
  // no split handle. The dock-top's close chevron is the only fold left, and
  // the shell owns it.
  const feed = useIssueEvents(readPosition, true)

  const refreshThreads = () => refreshSuperThreads().catch(() => {})

  // MINT THE SESSION SO THE CHAT CAN MOUNT (POD-782). Idempotent server-side and
  // guarded here by the session we already have, so opening the pane repeatedly
  // is one call at most. It creates a row and nothing else — no process, no
  // harness, no cost — and `clear` disposes it again.
  //
  // A failure is NOT surfaced as an error banner: the pane is simply not usable
  // yet, which the (empty, composer-less) chat already communicates, and a red
  // bar on a pane the user merely opened is noise. A retry rides the next open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshThreads is re-created each render
  useEffect(() => {
    if (podiumSessionId) return
    let cancelled = false
    void trpc.superagent.ensureSession
      .mutate({ threadId: THREAD_ID })
      .then(() => {
        if (!cancelled) void refreshThreads()
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [trpc, podiumSessionId, refreshSuperThreads])

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
  // turn re-primes from the seed) and clears the legacy rows. A running turn is
  // ABANDONED by this rather than refusing it (POD-782) — clearing is "throw
  // away what is happening here", so the state that most needs the hatch is no
  // longer the one state denied it. A terminal lock still refuses (#225): the
  // PTY is a second writer we cannot stop from here.
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
      {/* `data-prompt-bounds` is the surface the composer measures itself
          against: its cap is a share of THIS box, so a short dock never ends up
          mostly composer (usePromptAutoGrow). It is on the one wrapper now
          rather than on two branches of a condition. */}
      <div data-superagent-composer data-prompt-bounds className="flex min-h-0 flex-1 flex-col">
        {podiumSessionId ? (
          <ChatView
            sessionId={podiumSessionId}
            active
            superThread={{ threadId: THREAD_ID, kind: 'global' }}
            compact
            initialTurnRunning={thread?.turnRunning === true}
          />
        ) : (
          // The one frame before `ensureSession` answers. Deliberately blank
          // rather than a spinner: this resolves in a round-trip, and a spinner
          // that flashes for 80ms is worse than nothing arriving 80ms late.
          <div className="flex-1" data-testid="superagent-pane-warming" />
        )}
      </div>
    </section>
  )
}
