import { isSwitchTraced, markSwitch } from '@podium/client-core/perf'
import type { SuperThreadRef } from '@podium/client-core/values'
import type { SessionId } from '@podium/model/browser'
import { SWITCH_TRACE_MARKS } from '@podium/protocol'
import { useVoiceInput } from '@podium/terminal-client-react'
import { ArrowDownToLine } from 'lucide-react'
import type { JSX, MutableRefObject } from 'react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useConversation, type WebConversation } from './use-conversation'
import { TranscriptFeedBoundary } from '@/features/chat/TranscriptFeedBoundary'
import { cn } from '@/lib/utils'
import { ChatComposer } from './ChatComposer'
import { ChatRail } from './ChatRail'
import { isChatInteractable } from './chat-interactable'
import { handleChatMdClick } from './chat-md-click'
import { ImageLightbox } from './ImageLightbox'
import { IssueChipLiveness } from './IssueChipLiveness'
import { PinnedBrief } from './PinnedBrief'
import { TranscriptSearchBar } from './TranscriptSearchBar'
import { type ChatSurface, useChatLayout } from './use-chat-layout'

/**
 * THE BLOCKED-SESSION BAR (POD-2414), LAZY — because it draws nothing almost
 * always. A blocked session is the exception, so the card's markup, its answer
 * buttons and their styles have no business in the eager chunk every session
 * pays for. The gate below is one array scan, and the chunk is fetched the first
 * time a session is actually stopped on something.
 */
const PendingInteractionBar = lazy(() =>
  import('./PendingInteractionBar').then((module) => ({ default: module.PendingInteractionBar })),
)

/** Layout is local; live chat state is read by narrow observer leaves. */
export type { SuperThreadRef }

type QuoteDraftRef = MutableRefObject<((markdown: string) => void) | null>

/** Keep draft keystrokes in the composer leaf rather than re-running the whole
 * transcript/rail shell for every character. */
const ScopedChatComposer = observer(function ScopedChatComposer({
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
  const draft = chat.conversation.draft
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
      deliverable={chat.view.composer.deliverable}
      placeholder={chat.view.composer.placeholder}
      compact={compact}
      isMobile={chat.isMobile}
      onSend={submit}
      voice={voice}
      attachments={chat.attachments}
      turnRunning={chat.view.turnActive}
      canInterrupt={chat.conversation.sends.canInterrupt}
      onInterrupt={interrupt}
      interruptError={chat.conversation.sends.interruptError}
      offer={chat.view.offer}
      onOfferAction={chat.sendOfferPrompt}
      onOfferDismiss={chat.dismissOffer}
      session={chat.view.session}
      turnError={chat.view.turnError}
      transcriptFreshness={chat.conversation.transcript.freshness}
      offlineAsOf={chat.conversation.transcript.offlineAsOf}
      attached={chat.view.attached}
      autoFocusKey={sessionId}
      transcriptSettled={chat.view.phase !== 'loading'}
      {...(superThread
        ? {
            backend: chat.view.backend,
            onBackendModelChange: chat.view.setBackendModel,
            onBackendEffortChange: chat.view.setBackendEffort,
          }
        : {})}
    />
  )
})

type ChatViewProps = {
  sessionId: SessionId
  active?: boolean
  superThread?: SuperThreadRef
  compact?: boolean
  initialTurnRunning?: boolean
  initialPendingText?: string
  onInitialPendingSettled?: () => void
  deferInitialTranscript?: boolean
  onLeave?: (sessionId: SessionId) => void
}

export function ChatView(props: ChatViewProps): JSX.Element {
  const conversation = useConversation(props.sessionId, props)
  if (!conversation) return (
    <div className="flex min-h-0 flex-1 flex-col" data-chat-loading>
      {props.initialPendingText && <div className="transcript-pending">{props.initialPendingText}</div>}
    </div>
  )
  return <ConversationChatView {...props} conversation={conversation} />
}

const ConversationChatView = observer(function ConversationChatView({
  conversation,
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
  conversation: WebConversation
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
  const chat = useChatLayout({
    conversation,
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
  /**
   * IS THIS SESSION STOPPED ON SOMETHING? (POD-2414)
   *
   * A count, not a card: the bar is code-split, and this decides whether to
   * fetch it. Deliberately NOT `pendingInteractionCards` — that decides how an
   * ask RENDERS and belongs in the chunk it renders from; all this needs is
   * whether the aggregate holds an open row for this session. `?? []` because a
   * replica whose `pendingInteraction` collection has not arrived is a partial
   * world, not an error.
   */
  const quoteDraftRef = useRef<((markdown: string) => void) | null>(null)
  const [issueLivenessRoot, setIssueLivenessRoot] = useState<HTMLDivElement | null>(null)
  const quoteIntoDraft = useCallback((markdown: string) => {
    quoteDraftRef.current?.(markdown)
  }, [])
  // FIND. Opened from the rail's search button and nowhere else: ⌘F belongs to
  // the sidebar's task filter now (POD-1093, `useWorkFilter`), which is the one
  // chord in the product and cannot be shared — two window listeners on it meant
  // the transcript bar stole the focus the filter had just taken. `seq` bumps on
  // every open so pressing the button over an already-open bar remounts it,
  // which re-focuses and selects the surviving query.
  const [find, setFind] = useState<{ open: boolean; seq: number }>({ open: false, seq: 0 })
  const setQuery = chat.view.presentation.setQuery
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

  // Lifecycle observations live in their own leaf.

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
      <ChatLifecycle chat={chat} sessionId={sessionId} active={active} onLeave={onLeave} />
      {/* `offer-lift-region`: an opened offer fold pushes the whole transcript
          up under the panel header instead of resizing it — the feed keeps its
          box, so nothing here re-renders or loses its scroll (POD-1068). */}
      <div ref={setIssueLivenessRoot} className="offer-lift-region relative flex min-h-0 flex-1">
        {/* The brief that scrolled off the top, held over the column rather than
            in it — see PinnedBrief for why the pin left the flow. It sits inside
            the same relative box the rail does and stops short of it, so the
            shelf and the feed share one measure.
            DOM order matches visual order (POD-4829): the shelf is drawn OVER the
            top of the feed, so it is mounted BEFORE the scroller. Mounted after,
            any DOM-order reader (text scrape, screen reader, tab order) met the
            scrolled-off prompt AGAIN at the bottom, just before the composer's
            live region — the desktop-only repeat the phone never showed. */}
        {!compact && (
          <PinnedBrief
            brief={chat.scroll.pinnedBrief}
            scrollerRef={chat.scrollerRef}
            scrollBy={chat.scroll.scrollBy}
            onBodyClick={(e) => {
              handleChatMdClick(e, sessionId, chat.view.cwd, chat.openFile)
            }}
          />
        )}
        <Suspense fallback={null}>
          <ConversationTranscript chat={chat} sessionId={sessionId} onQuote={quoteIntoDraft} />
        </Suspense>
        {/* The reading rail. Its map covers the RENDERED window (visibleRows), so
            its bands line up with the scrollable content. For a very long
            transcript that means it reflects the loaded/visible tail, not the
            entire on-disk history; scrolling up to page in older items extends
            what it covers. */}
        {!compact && (
          <ReadingRail chat={chat} findOpen={find.open}
            onFind={() => setFind((f) => ({ open: true, seq: f.seq + 1 }))} />
        )}
        {/* Find floats OVER the feed rather than displacing it, so entering and
            leaving the mode never reflows what you were reading. */}
        {!compact && find.open && (
          <FindBar key={find.seq} chat={chat} onClose={closeFind} />
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
      {/* Between the feed and the composer, because an ask that scrolls away is
          the failure the aggregate exists to fix — and because the composer is
          where a person's attention already is when they come to unblock
          something. `fallback={null}` because the bar's own empty state is
          nothing: a one-frame gap before a card appears reads as the card
          appearing, while a spinner over the composer would not. */}
      <InteractionGate chat={chat} sessionId={sessionId} compact={compact} />
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
})

const ConversationTranscript = observer(function ConversationTranscript({ chat, sessionId, onQuote }: { chat: ChatSurface; sessionId: SessionId; onQuote: (markdown: string) => void }) {
  return (
          <TranscriptFeedBoundary
            chat={chat}
            setScrollerRef={chat.scroll.setScrollerRef}
            setContentRef={chat.scroll.setContentRef}
            onScroll={chat.scroll.onScroll}
            onPointerUp={chat.scroll.onPointerUp}
            compact={chat.view.compact}
            superagent={chat.conversation.mount.superThread !== undefined}
            phase={chat.view.phase}
            rows={chat.view.rowsToRender}
            blockCount={chat.view.presentation.blockCount}
            markdownHtml={chat.view.presentation.markdownHtml}
            search={chat.view.presentation.search}
            revealedRow={chat.revealedRow}
            moreAbove={chat.view.moreAbove}
            loadingOlder={chat.conversation.transcript.loadingOlder}
            loadOlder={chat.scroll.loadOlder}
            sessionId={sessionId}
            cwd={chat.view.cwd}
            session={chat.view.session}
            httpOrigin={chat.httpOrigin}
            openFile={chat.openFile}
            onOpenImage={chat.setLightbox}
            onAnswerAsk={chat.answerAsk}
            answerInteractionId={chat.view.question?.id}
            livePendingAskIndex={chat.view.livePendingAskIndex}
            pendingAskBlock={chat.view.pendingAskBlock}
            lastAnswerBlockIndex={chat.view.presentation.lastAnswer.blockIndex}
            collapseContext={chat.view.headless}
            stickyEnabled={chat.view.stickyEnabled}
            isOperatorPromptRow={chat.view.isOperatorPromptRow}
            onRetryPending={chat.retryPending}
            onDiscardPending={chat.discardPending}
            onSendAgain={chat.sendAgain}
            onRetractQueued={chat.retractQueuedMessage}
            offlineMachineName={chat.conversation.transcript.offlineMachineName}
            presenceOfflineMachineName={chat.view.presenceOfflineMachineName}
            attribution={chat.view.attribution}
            expandRuns={false}
            // Per-message Quote (POD-376): the feed builds the blockquote, the
            // shell owns the draft. Appended rather than replacing, so quoting
            // twice — or quoting into a half-written reply — never eats text.
            onQuote={onQuote}
          />
  )
})

const ChatLifecycle = observer(function ChatLifecycle({ chat, sessionId, active, onLeave }: {
  chat: ChatSurface; sessionId: SessionId; active: boolean; onLeave?: (sessionId: SessionId) => void
}) {
  // Leave once, quietly. Not a toast and not an animation — see the header.
  useEffect(() => {
    if (chat.view.gone) onLeave?.(sessionId)
  }, [chat.view.gone, onLeave, sessionId])

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
      const transcriptCommitted = chat.view.phase !== 'loading'
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
  }, [active, chat.view.phase, sessionId])

  return null
})
const InteractionGate = observer(function InteractionGate({ chat, sessionId, compact }: {
  chat: ChatSurface; sessionId: SessionId; compact: boolean
}) {
  return chat.view.blocked ? <Suspense fallback={null}><PendingInteractionBar sessionId={sessionId} compact={compact} /></Suspense> : null
})
const ReadingRail = observer(function ReadingRail({ chat, findOpen, onFind }: {
  chat: ChatSurface; findOpen: boolean; onFind: () => void
}) { return (
          <ChatRail
            rows={chat.view.presentation.visibleRows}
            baseIndex={chat.view.presentation.renderStart}
            isOperatorPromptRow={chat.view.isOperatorPromptRow}
            scrollerRef={chat.scrollerRef}
            scrollToOffset={chat.scroll.scrollToOffset}
            matches={chat.view.presentation.search.matches}
            activeMatch={chat.view.presentation.search.activeMatch}
            findOpen={findOpen}
            onFind={onFind}
            lastAnswerText={chat.view.presentation.lastAnswer.text}
            onTldr={chat.tldr}
          />
) })
const FindBar = observer(function FindBar({ chat, onClose }: { chat: ChatSurface; onClose: () => void }) {
  return (
          <TranscriptSearchBar
            query={chat.view.presentation.query}
            onQueryChange={chat.view.presentation.setQuery}
            search={chat.view.presentation.search}
            onCursorMove={chat.view.presentation.moveCursor}
            deepeningSearch={chat.view.presentation.deepeningSearch}
            onClose={onClose}
          />
  )
})
