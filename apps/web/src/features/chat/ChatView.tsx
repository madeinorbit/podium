import { isSwitchTraced, markSwitch } from '@podium/client-core/perf'
import type { SuperThreadRef } from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model'
import { SWITCH_TRACE_MARKS } from '@podium/protocol'
import { ArrowDownToLine } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect } from 'react'
import { cn } from '@/lib/utils'
import { ChatComposer } from './ChatComposer'
import { isChatInteractable } from './chat-interactable'
import { ImageLightbox } from './ImageLightbox'
import { Minimap } from './Minimap'
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
 *  - `TranscriptSearchBar` / `TranscriptFeed` / `Minimap` / `ChatComposer`
 *    (with `VoiceButton` + `AttachmentStrip`) / `ImageLightbox` — the pieces.
 *
 * This file holds the LAYOUT: header, feed, minimap, jump-to-bottom, composer.
 * Narrow-dock mode (`compact`) is expressed by which of those it mounts rather
 * than by conditions scattered through a thousand lines — the header and minimap
 * are simply absent there (engraved-column.md §2.5: bar → feed → composer).
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
  /** Narrow-dock mode (the superagent side panel): hides the search header,
   *  minimap + tl;dr. */
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
      {/* Search + tl;dr header — hidden in the compact superagent dock. */}
      {!compact && (
        <TranscriptSearchBar
          query={chat.query}
          onQueryChange={chat.setQuery}
          search={chat.search}
          onCursorMove={chat.moveMatchCursor}
          deepeningSearch={chat.deepeningSearch}
          lastAnswerText={chat.lastAnswerText}
          onTldr={chat.tldr}
        />
      )}
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
        />
        {/* Minimap maps the RENDERED window (visibleRows), so its segments line
            up with the scrollable content. For a very long transcript that means
            it reflects the loaded/visible tail, not the entire on-disk history;
            scrolling up to page in older items extends what it covers. */}
        {!compact && <Minimap rows={chat.visibleRows} scrollerRef={chat.scrollerRef} />}
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
