import { isSwitchTraced, markSwitch } from '@podium/client-core/perf'
import type { SuperThreadRef } from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model'
import { SWITCH_TRACE_MARKS } from '@podium/protocol'
import { ArrowDownToLine } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { ChatComposer } from './ChatComposer'
import { isChatInteractable } from './chat-interactable'
import { ChatRail } from './ChatRail'
import { ImageLightbox } from './ImageLightbox'
import { OpenTodosNotice, stoppedWithOpenTodos, useIssueTodos } from './TodoBridge'
import { TranscriptFeed } from './TranscriptFeed'
import { TranscriptSearchBar } from './TranscriptSearchBar'
import { useChatSurface } from './use-chat-surface'

/**
 * CHAT (POD-405) — the SHELL, and nothing else.
 *
 * What used to be 1,442 lines of subscribing, deriving, scrolling, uploading,
 * routing and rendering is now parts with one job each:
 *
 *  - `packages/client-core/src/viewmodels/slices/chat.ts` — every view-model
 *    question, as pure functions, platform-neutral and testable without a DOM;
 *  - `use-chat-surface.ts` — the source: store + transcript window + slice,
 *    assembled once;
 *  - `use-transcript-scroll.ts` — scroll anchoring and the sticky prompt hand-off;
 *  - `use-chat-send.ts` — sending, optimistic bubbles and their reconciliation;
 *  - `use-headless-turn.ts` — headless superagent-thread routing;
 *  - `use-attachments.ts` — image paste / drop / attach and upload;
 *  - `ChatRail` (with `Minimap` + `VerbosityControl` + the todo chip) /
 *    `TranscriptSearchBar` / `TranscriptFeed` / `ChatComposer` (with
 *    `VoiceButton` + `AttachmentStrip`) / `ImageLightbox` — the pieces.
 *
 * This file holds the LAYOUT: feed, rail, find, jump-to-bottom, composer.
 * Narrow-dock mode (`compact`) is expressed by which of those it mounts rather
 * than by conditions scattered through a thousand lines — the rail and find are
 * simply absent there (engraved-column.md §2.5: bar → feed → composer).
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO HEADER (POD-413)
 * ---------------------------------------------------------------------------
 *
 * There used to be one, and it was a full-width row carrying a search field the
 * majority of sessions never touched. It is gone rather than shrunk: a permanent
 * horizontal band is subtracted from the transcript on every session forever,
 * and a thinner one is the same trade at a discount. What was in it went to the
 * two places that were already permanent —
 *
 *   the RAIL   the minimap's gutter, widened from 14px to 24px, now carrying
 *              todo progress, find, density and tl;dr above the map (ChatRail);
 *   ⌘F         search itself, which is a mode you enter, not furniture
 *              (TranscriptSearchBar, floating over the feed).
 *
 * Net: one row of vertical space returned to the conversation, 7px of width
 * spent, and nothing lost — the match cursor, the provisional n/m and the map
 * integration all survive, the last of them stronger than before, because the
 * map now marks every hit and keeps marking them once the bar is closed.
 *
 * ---------------------------------------------------------------------------
 * WHEN THE SESSION LEAVES YOUR VIEW
 * ---------------------------------------------------------------------------
 *
 * Under the scoped feed (POD-1077) an open chat's session can be EVICTED — a
 * share revoked, the row gone from your replica, its revision untouched. That is
 * a visibility change, not a deletion, so this view leaves QUIETLY: no toast, no
 * tombstone, no removal animation, and no re-request of the vanished id (which
 * would be a heal loop against a row that is not coming back). A genuinely
 * deleted session takes the same exit, deliberately: per doc §3.1.5 acting on an
 * invisible entity must be indistinguishable from acting on one that never
 * existed, and a UI that animated one and not the other would answer "does this
 * exist?" for free.
 */
export type { SuperThreadRef }

export function ChatView({
  sessionId,
  active = true,
  superThread,
  compact = false,
  initialTurnRunning = false,
  initialPendingText,
  onLeave,
}: {
  sessionId: SessionId
  /** False when this panel is mounted but hidden (keep-mounted deck). On
   *  becoming active (true) the view snaps to the bottom if still pinned. */
  active?: boolean
  /** Present when this ChatView is embedded in the superagent panel over a
   *  HEADLESS session — routes sends through the superagent turn mutations. */
  superThread?: SuperThreadRef
  /** Narrow-dock mode (the superagent side panel): hides the reading rail (map,
   *  density, todos, tl;dr) and find. */
  compact?: boolean
  /** Query-backed headless state for clients that mounted after turn-start. */
  initialTurnRunning?: boolean
  /** The first prompt shown optimistically while the freshly-created headless
   * transcript catches up to the thread/session swap. */
  initialPendingText?: string
  /** Called once when the session leaves the principal's view (evicted or
   *  deleted) so the host can navigate away. Optional: a host that does not
   *  provide it simply renders the blank surface, which is still not a
   *  deletion affordance. */
  onLeave?: (sessionId: SessionId) => void
}): JSX.Element {
  const chat = useChatSurface({
    sessionId,
    active,
    superThread,
    compact,
    initialTurnRunning,
    ...(initialPendingText !== undefined
      ? { initialPendingText }
      : { initialPendingText: undefined }),
  })

  // Leave once, quietly. Not a toast and not an animation — see the header.
  useEffect(() => {
    if (chat.gone) onLeave?.(sessionId)
  }, [chat.gone, onLeave, sessionId])

  // FIND (⌘F / Ctrl-F). `findSeq` bumps on every open so a second press over an
  // already-open bar remounts it, which re-focuses and selects the surviving
  // query — the behaviour every browser's find has, and the reason a shortcut
  // is worth more than a permanent field.
  const [find, setFind] = useState<{ open: boolean; seq: number }>({ open: false, seq: 0 })
  const { setQuery } = chat
  const closeFind = useCallback(() => {
    setFind((f) => ({ ...f, open: false }))
    // Clear as we leave: a query that survives an invisible bar keeps overriding
    // the reader's Summary setting and keeps marking the map, with no visible
    // cause. Closing find means finding is over.
    setQuery('')
  }, [setQuery])
  useEffect(() => {
    if (compact || !active) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFind((f) => ({ open: true, seq: f.seq + 1 }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [compact, active])

  // Esc closes find from anywhere in the pane, not only from inside its input —
  // you may well have clicked into the transcript to read a hit.
  useEffect(() => {
    if (!find.open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeFind()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [find.open, closeFind])

  // The todo bridge (POD-413): the issue's published plan, counted. Null when
  // this session has no issue or the issue has no todos — the rail chip and the
  // end-of-transcript notice both simply don't exist in that case.
  const todos = useIssueTodos(chat.session)
  const showTodoStop = stoppedWithOpenTodos({
    session: chat.session,
    todos,
    working: chat.activity?.tone === 'working',
  })

  // Publish the scroller's own height so a sticky operator prompt can cap
  // itself at a fraction of the chat viewport in CSS (POD-1368 — the clamp
  // itself is `.transcript-you-clamp` in styles.css, driven by ChatBlockView).
  // Setting a custom property here is loop-safe: the scroller is sized by its
  // flex parent, so nothing it publishes can feed back into its own box.
  const { scrollerRef } = chat
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const publish = (): void => {
      el.style.setProperty('--chat-viewport-h', `${el.clientHeight}px`)
    }
    publish()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollerRef])

  // `chat:interactable` is the actual chat finish line: wait until the textarea
  // exists, is enabled and focusable, and the transcript has either committed
  // its settled (including empty) state or is already scrollable. Two rAFs keep
  // the paint mark ahead of this one, so the trace exposes the paint→input gap.
  // Retry while the browser is still laying out a committed transcript; the
  // switch collector's timeout is the outer backstop.
  // Keep checking until that 10s confirmation deadline. If the predicate never
  // becomes true, no interactable mark is emitted: timedOut means unconfirmed,
  // not a measured 10s interactability latency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: DOM refs are stable; the frame retry observes their mounted/layout state.
  useEffect(() => {
    if (!active || !isSwitchTraced(sessionId)) return
    let cancelled = false
    let firstFrame: number | undefined
    let checkFrame: number | undefined

    const check = (): void => {
      if (cancelled || !isSwitchTraced(sessionId)) return
      const textarea = chat.taRef.current
      const transcript = chat.scrollerRef.current
      const transcriptCommitted = chat.phase !== 'loading'
      if (isChatInteractable({ textarea, transcript, transcriptCommitted })) {
        markSwitch(sessionId, SWITCH_TRACE_MARKS.chatInteractable, {
          composerEnabled: textarea?.disabled === false,
          composerFocusable: true,
          transcriptCommitted,
          transcriptScrollable:
            transcript !== null && transcript.scrollHeight > transcript.clientHeight,
        })
        return
      }
      if (typeof requestAnimationFrame === 'function') checkFrame = requestAnimationFrame(check)
      else return
    }

    if (typeof requestAnimationFrame === 'function') {
      firstFrame = requestAnimationFrame(() => {
        checkFrame = requestAnimationFrame(check)
      })
    } else {
      check()
    }
    return () => {
      cancelled = true
      if (firstFrame !== undefined) cancelAnimationFrame(firstFrame)
      if (checkFrame !== undefined) cancelAnimationFrame(checkFrame)
    }
  }, [active, chat.phase, sessionId])

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', compact && 'chat-compact')}>
      <div className="relative flex min-h-0 flex-1">
        <TranscriptFeed
          scrollerRef={chat.scrollerRef}
          onScroll={chat.scroll.onScroll}
          compact={compact}
          phase={chat.phase}
          rows={chat.rowsToRender}
          blocks={chat.blocks}
          search={chat.search}
          query={chat.query}
          moreAbove={chat.moreAbove}
          loadingOlder={chat.loadingOlder}
          loadOlder={chat.loadOlder}
          sessionId={sessionId}
          cwd={chat.cwd}
          session={chat.session}
          httpOrigin={chat.httpOrigin}
          openFile={chat.openFile}
          onOpenImage={chat.setLightbox}
          onAnswerAsk={chat.answerAsk}
          livePendingAskIndex={chat.livePendingAskIndex}
          lastAnswerBlockIndex={chat.lastAnswerBlockIndex}
          ctxSeq={chat.ctxSeq}
          collapseContext={chat.headless}
          stickyEnabled={chat.stickyEnabled}
          isOperatorPromptRow={chat.isOperatorPromptRow}
          pending={chat.pending}
          restoredQueued={chat.restoredQueued}
          overlay={chat.headless ? chat.headlessTurn.overlay : null}
          activity={chat.activity}
          attribution={chat.attribution}
          expandRuns={chat.expandRuns}
          // Per-message Quote (POD-376): the feed builds the blockquote, the
          // shell owns the draft. Appended rather than replacing, so quoting
          // twice — or quoting into a half-written reply — never eats text.
          onQuote={(markdown) => {
            chat.setDraft(
              chat.draft ? `${chat.draft.replace(/\s*$/, '\n\n')}${markdown}` : markdown,
            )
            chat.taRef.current?.focus()
          }}
        />
        {/* The reading rail. Its map covers the RENDERED window (visibleRows), so
            its bands line up with the scrollable content. For a very long
            transcript that means it reflects the loaded/visible tail, not the
            entire on-disk history; scrolling up to page in older items extends
            what it covers. */}
        {!compact && (
          <ChatRail
            rows={chat.visibleRows}
            scrollerRef={chat.scrollerRef}
            matches={chat.search.matches}
            activeMatch={chat.search.activeMatch}
            verbosity={chat.verbosity}
            onVerbosityChange={chat.setVerbosity}
            verbosityOverridden={chat.verbosity === 'summary' && chat.query !== ''}
            todos={todos}
            findOpen={find.open}
            onFind={() => setFind((f) => ({ open: true, seq: f.seq + 1 }))}
            lastAnswerText={chat.lastAnswerText}
            onTldr={chat.tldr}
          />
        )}
        {/* Find floats OVER the feed rather than displacing it, so entering and
            leaving the mode never reflows what you were reading. */}
        {!compact && find.open && (
          <TranscriptSearchBar
            key={find.seq}
            query={chat.query}
            onQueryChange={chat.setQuery}
            search={chat.search}
            onCursorMove={chat.moveMatchCursor}
            deepeningSearch={chat.deepeningSearch}
            onClose={closeFind}
          />
        )}
        {!chat.scroll.atBottom && (
          <button
            data-pressable
            type="button"
            className="absolute bottom-3 left-1/2 z-[4] inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-input bg-muted px-3 py-[5px] text-xs text-foreground shadow-[0_4px_14px_var(--carve-popover-near)] hover:border-primary"
            onClick={chat.scroll.jumpToBottom}
          >
            <ArrowDownToLine size={13} aria-hidden="true" /> Jump to bottom
          </button>
        )}
      </div>
      {/* The agent stopped and the plan still has items on it. Said once, at the
          end of the transcript where the reader already is, and pointing at the
          panel — chat does not keep a second copy of the list (TodoBridge). */}
      {!compact && showTodoStop && todos && <OpenTodosNotice todos={todos} />}
      <ChatComposer
        taRef={chat.taRef}
        draft={chat.draft}
        onDraftChange={chat.setDraft}
        enabled={chat.composer.enabled}
        placeholder={chat.composer.placeholder}
        compact={compact}
        isMobile={chat.isMobile}
        onSend={chat.submit}
        voice={chat.voice}
        attachments={chat.attachments}
        headless={chat.headless}
        turnRunning={chat.headlessTurn.turnRunning}
        canInterrupt={chat.canInterrupt}
        onInterrupt={chat.headlessTurn.interrupt}
        offer={chat.offer}
        onOfferAction={chat.sendOfferPrompt}
        session={chat.session}
        queuedTotal={chat.queuedTotal}
        turnError={chat.headlessTurn.turnError}
        offlineAsOf={chat.offlineAsOf}
        autoFocusKey={sessionId}
        transcriptSettled={chat.phase !== 'loading'}
      />
      <ImageLightbox src={chat.lightbox} onClose={() => chat.setLightbox(null)} />
    </div>
  )
}
