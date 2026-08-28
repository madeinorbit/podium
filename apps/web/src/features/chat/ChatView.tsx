import { isSwitchTraced, markSwitch } from '@podium/client-core/perf'
import type { SuperThreadRef } from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model/browser'
import { SWITCH_TRACE_MARKS } from '@podium/protocol'
import { useVoiceInput } from '@podium/terminal-client-react'
import { ArrowDownToLine } from 'lucide-react'
import type { JSX, MutableRefObject } from 'react'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSessionDraft } from '@/app/store'
import { TranscriptFeedBoundary } from '@/features/chat/TranscriptFeedBoundary'
import { cn } from '@/lib/utils'
import { handleChatMdClick } from './chat-md-click'
import { ChatComposer } from './ChatComposer'
import { ChatRail } from './ChatRail'
import { isChatInteractable } from './chat-interactable'
import { ImageLightbox } from './ImageLightbox'
import { IssueChipLiveness } from './IssueChipLiveness'
import { PinnedBrief } from './PinnedBrief'
import { TranscriptSearchBar } from './TranscriptSearchBar'
import { type ChatSurface, useChatSurface } from './use-chat-surface'

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
 *  - `ChatRail` (with `Minimap` + the todo chip) /
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
 *              find, density and tl;dr above the map (ChatRail);
 *   its FIND   search itself, which is a mode you enter, not furniture
 *              (TranscriptSearchBar, floating over the feed). The rail's button
 *              is the whole way in — ⌘F went to the sidebar's task filter in
 *              POD-1093, so find is a click, not a chord.
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

type QuoteDraftRef = MutableRefObject<((markdown: string) => void) | null>

/** Keep draft keystrokes in the composer leaf rather than re-running the whole
 * transcript/rail shell for every character. */
function ScopedChatComposer({
  sessionId,
  superThread,
  compact,
  chat,
  quoteDraftRef,
}: {
  sessionId: SessionId
  superThread: SuperThreadRef | undefined
  compact: boolean
  chat: ChatSurface
  quoteDraftRef: QuoteDraftRef
}): JSX.Element {
  const draft = useSessionDraft(sessionId)
  const setDraft = chat.setDraft
  const voice = useVoiceInput((text) => setDraft(draft ? `${draft} ${text}` : text))
  quoteDraftRef.current = (markdown) => {
    setDraft(draft ? `${draft.replace(/\s*$/, '\n\n')}${markdown}` : markdown)
    chat.taRef.current?.focus()
  }
  const submit = useCallback(() => chat.submitDraft(draft), [chat.submitDraft, draft])
  const interrupt = useCallback(() => chat.interrupt(draft), [chat.interrupt, draft])

  return (
    <ChatComposer
      taRef={chat.taRef}
      draft={draft}
      onDraftChange={setDraft}
      enabled={chat.composer.enabled}
      placeholder={chat.composer.placeholder}
      compact={compact}
      isMobile={chat.isMobile}
      onSend={submit}
      voice={voice}
      attachments={chat.attachments}
      turnRunning={chat.turnActive}
      canInterrupt={chat.canInterrupt}
      onInterrupt={interrupt}
      interruptError={chat.interruptError}
      offer={chat.offer}
      onOfferAction={chat.sendOfferPrompt}
      onOfferDismiss={chat.dismissOffer}
      session={chat.session}
      turnError={chat.headlessTurn.turnError}
      offlineAsOf={chat.offlineAsOf}
      attached={chat.attached}
      autoFocusKey={sessionId}
      transcriptSettled={chat.phase !== 'loading'}
      {...(superThread
        ? {
            backend: chat.backend,
            onBackendModelChange: chat.setBackendModel,
            onBackendEffortChange: chat.setBackendEffort,
          }
        : {})}
    />
  )
}

export function ChatView({
  sessionId,
  active = true,
  superThread,
  compact = false,
  initialTurnRunning = false,
  initialPendingText,
  onInitialPendingSettled,
  deferInitialTranscript = false,
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
   *  density, tl;dr) and find. */
  compact?: boolean
  /** Query-backed headless state for clients that mounted after turn-start. */
  initialTurnRunning?: boolean
  /** The first prompt shown optimistically while the freshly-created headless
   * transcript catches up to the thread/session swap. */
  initialPendingText?: string
  /** Called once the transcript echoes `initialPendingText`. */
  onInitialPendingSettled?: () => void
  /** Wait to read/subscribe until a client-minted session id exists on the
   * authority. The optimistic prompt remains visible during this boundary. */
  deferInitialTranscript?: boolean
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
    deferInitialTranscript,
    ...(initialPendingText !== undefined
      ? { initialPendingText }
      : { initialPendingText: undefined }),
    onInitialPendingSettled,
  })
  const quoteDraftRef = useRef<((markdown: string) => void) | null>(null)
  const [issueLivenessRoot, setIssueLivenessRoot] = useState<HTMLDivElement | null>(null)
  const quoteIntoDraft = useCallback((markdown: string) => {
    quoteDraftRef.current?.(markdown)
  }, [])
  // Leave once, quietly. Not a toast and not an animation — see the header.
  useEffect(() => {
    if (chat.gone) onLeave?.(sessionId)
  }, [chat.gone, onLeave, sessionId])

  // FIND. Opened from the rail's search button and nowhere else: ⌘F belongs to
  // the sidebar's task filter now (POD-1093, `useWorkFilter`), which is the one
  // chord in the product and cannot be shared — two window listeners on it meant
  // the transcript bar stole the focus the filter had just taken. `seq` bumps on
  // every open so pressing the button over an already-open bar remounts it,
  // which re-focuses and selects the surviving query.
  const [find, setFind] = useState<{ open: boolean; seq: number }>({ open: false, seq: 0 })
  const { setQuery } = chat
  const closeFind = useCallback(() => {
    setFind((f) => ({ ...f, open: false }))
    // Clear as we leave: a query that survives an invisible bar keeps overriding
    // the reader's Summary setting and keeps marking the map, with no visible
    // cause. Closing find means finding is over.
    setQuery('')
  }, [setQuery])
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

  // Publish the scroller's own height so an operator prompt can decide whether
  // it is short enough to take the sticky pin (POD-1368; `usePinnable` in
  // ChatBlockView reads this off the inherited custom property). Setting one
  // here is loop-safe: the scroller is sized by its flex parent, so nothing it
  // publishes can feed back into its own box.
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
    /**
     * THE WHOLE CONVERSATION IS THE DROP TARGET (POD-1595).
     *
     * These handlers used to sit on the composer dock alone — a strip about
     * seventy pixels tall at the very bottom of the pane. Dragging a file into
     * a chat means dragging it at the CONVERSATION, and the conversation is the
     * other ninety percent of the surface: over all of it the cursor said "no",
     * releasing did nothing, and in a plain browser tab the page navigated away
     * to the dropped file, taking the half-written prompt with it.
     *
     * WHAT ACCEPTS THE DROP AND WHAT LIGHTS UP ARE NOT THE SAME RECTANGLE, and
     * that is the point (POD-1595, second pass). The first cut drew the target
     * over the whole conversation, which answered "can I drop here?" and then
     * left "…and where does it GO?" unanswered — a dashed box around everything
     * reads as the file landing on the transcript. So the hit area stays wide,
     * because that is the bug, and the composer is what highlights, because that
     * is the destination: drop anywhere, it lands in your prompt.
     */
    <div
      className={cn('relative flex min-h-0 flex-1 flex-col', compact && 'chat-compact')}
      // NOT WHILE THE LIGHTBOX IS UP. It is a child of this surface, so a drag
      // over it bubbles here — and the veil (z-20) would draw UNDERNEATH the
      // lightbox (z-100), so releasing a file over a full-screen image attached
      // it silently, with nothing on screen having offered to. Standing down
      // hands the drag to `useFileDropGuard`, which swallows it harmlessly.
      {...(chat.lightbox === null ? chat.attachments.dropHandlers : {})}
    >
      {/* `offer-lift-region`: an opened offer fold pushes the whole transcript
          up under the panel header instead of resizing it — the feed keeps its
          box, so nothing here re-renders or loses its scroll (POD-1068). */}
      <div ref={setIssueLivenessRoot} className="offer-lift-region relative flex min-h-0 flex-1">
        <Suspense fallback={null}>
          <TranscriptFeedBoundary
            setScrollerRef={chat.scroll.setScrollerRef}
            setContentRef={chat.scroll.setContentRef}
            onScroll={chat.scroll.onScroll}
            onPointerUp={chat.scroll.onPointerUp}
            compact={compact}
            superagent={superThread !== undefined}
            phase={chat.phase}
            rows={chat.rowsToRender}
            blocks={chat.blocks}
            markdownHtml={chat.markdownHtml}
            search={chat.search}
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
            pendingAskBlock={chat.pendingAskBlock}
            lastAnswerBlockIndex={chat.lastAnswerBlockIndex}
            ctxSeq={chat.ctxSeq}
            collapseContext={chat.headless}
            stickyEnabled={chat.stickyEnabled}
            isOperatorPromptRow={chat.isOperatorPromptRow}
            pending={chat.pending}
            restoredQueued={chat.restoredQueued}
            onRetractQueued={chat.retractQueuedMessage}
            overlay={chat.headless ? chat.headlessTurn.overlay : null}
            activity={chat.activity}
            attribution={chat.attribution}
            expandRuns={chat.expandRuns}
            // Per-message Quote (POD-376): the feed builds the blockquote, the
            // shell owns the draft. Appended rather than replacing, so quoting
            // twice — or quoting into a half-written reply — never eats text.
            onQuote={quoteIntoDraft}
          />
        </Suspense>
        {/* The brief that scrolled off the top, held over the column rather than
            in it — see PinnedBrief for why the pin left the flow. It sits inside
            the same relative box the rail does and stops short of it, so the
            shelf and the feed share one measure. */}
        {!compact && (
          <PinnedBrief
            brief={chat.scroll.pinnedBrief}
            scrollerRef={chat.scrollerRef}
            onBodyClick={(e) => {
              handleChatMdClick(e, sessionId, chat.cwd, chat.openFile)
            }}
          />
        )}
        {/* The reading rail. Its map covers the RENDERED window (visibleRows), so
            its bands line up with the scrollable content. For a very long
            transcript that means it reflects the loaded/visible tail, not the
            entire on-disk history; scrolling up to page in older items extends
            what it covers. */}
        {!compact && (
          <ChatRail
            rows={chat.visibleRows}
            baseIndex={chat.renderStart}
            isOperatorPromptRow={chat.isOperatorPromptRow}
            scrollerRef={chat.scrollerRef}
            matches={chat.search.matches}
            activeMatch={chat.search.activeMatch}
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
            className="absolute bottom-3 left-1/2 z-[4] inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-input bg-muted px-3 py-[5px] text-xs text-foreground shadow-[0_4px_14px_var(--carve-popover-near)] hover:border-foreground/30"
            onClick={chat.scroll.jumpToBottom}
          >
            <ArrowDownToLine size={13} aria-hidden="true" /> Jump to bottom
          </button>
        )}
      </div>
      {/* Host attachment is state so this leaf re-arms wherever it sits in the
          tree; issue deltas still render only the leaf and mutate attributes. */}
      <IssueChipLiveness root={issueLivenessRoot} />
      <ScopedChatComposer
        sessionId={sessionId}
        superThread={superThread}
        compact={compact}
        chat={chat}
        quoteDraftRef={quoteDraftRef}
      />
      <ImageLightbox src={chat.lightbox} onClose={() => chat.setLightbox(null)} />
    </div>
  )
}
