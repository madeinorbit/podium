import type { SessionView } from '@podium/client-core/session-values'
import {
  type ChatActivity,
  type ChatRow,
  type ChatSessionReference,
  type ComposerState,
  chatActivityState,
  chatSessionReference,
  composerState,
  isOperatorPromptRow as isOperatorPromptRowOf,
  lastAnswer as lastAnswerOf,
  livePendingAskIndex as livePendingAskIndexOf,
  matchesQuestionInteraction,
  type OperatorPromptOptions,
  parseEnvelopeBatch,
  pendingAskFromState,
  type RenderableRow,
  renderableRows,
  type SuperThreadRef,
  type TranscriptAttributionTable,
  type TranscriptPhase,
  type TranscriptSearchState,
  transcriptAttributionTable,
  transcriptPhase,
} from '@podium/client-core/values'
import {
  isAgentComputing,
  isMachineOfflineForLiveTerminal,
  type SessionId,
} from '@podium/model/browser'
import type { RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePoolMachine } from '@/app/header-data'
import { useRuntimeActions } from '@/app/keyed-runtime'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { useStickyPromptsPreference } from '@/lib/sticky-prompts'
import type { ChatBlock, PendingItem } from './chat'
import { type UseAttachmentsResult, useAttachments } from './use-attachments'
import {
  useChatContextWindow,
  useChatInteractions,
  useChatSession,
  useChatSessionExitKind,
} from './use-chat-context'
import type { WebConversation } from './use-conversation'
import type { HeadlessOverlay, TurnPreview } from '@podium/client-core/conversation'
import { useTranscriptReveal } from './use-transcript-reveal'
import { type UseTranscriptScrollResult, useTranscriptScroll } from './use-transcript-scroll'

import { RENDER_WINDOW } from './conversation-presentation'
import type { TranscriptFreshness } from '@podium/client-core/transcript'

/** DOM-only layout: attachments, scroll anchoring, search navigation and reveal.
 * Live transcript, drafts, sends and overlays belong to the warm conversation. */

export interface UseChatLayoutOptions {
  conversation: WebConversation
  sessionId: SessionId
  active: boolean
  superThread: SuperThreadRef | undefined
  compact: boolean
  initialTurnRunning: boolean
  initialPendingText: string | undefined
  onInitialPendingSettled?: () => void
  deferInitialTranscript: boolean
}

export interface ChatSurface {
  conversation: WebConversation
  // -- identity and the partial world ----------------------------------------
  session: SessionView | undefined
  /** The chat's own referent. `not-visible` is an eviction, not a deletion. */
  reference: ChatSessionReference
  /** True when the session left the principal's view and the shell must leave
   *  quietly — no toast, no tombstone, no re-request of the vanished id. */
  gone: boolean
  cwd: string
  headless: boolean
  compact: boolean
  httpOrigin: string
  /** "Ask superagent (BTW)" (POD-1069): the session whose transcript digest the
   *  NEXT turn from this composer will carry, with the way to drop it. Null on
   *  every chat but the superagent's — the store field is app-wide, and an
   *  ordinary session's composer would be naming context it never sends. */
  attached: { sessionId: SessionId; label: string; clear: () => void } | null

  // -- the transcript --------------------------------------------------------
  blocks: ChatBlock[]
  rows: ChatRow[]
  rowsToRender: readonly RenderableRow[]
  /** First windowed-in row: the base every rendered `[data-block]` index is
   *  absolute against, and what `visibleRows[0]` actually is. */
  renderStart: number
  /** Unsafe worker HTML keyed by source Markdown; TranscriptFeed sanitizes it. */
  markdownHtml: ReadonlyMap<string, string>
  phase: TranscriptPhase
  transcriptFreshness: TranscriptFreshness
  moreAbove: boolean
  loadingOlder: boolean
  loadOlder: () => void
  offlineAsOf: number | null
  /** The session's machine is offline (POD-4808) — names the machine so the
   *  chat can say WHY history is missing and mark a live-looking session. */
  offlineMachineName: string | null
  /** LIVE machine presence for the half-2 banner (POD-4808 review): derived
   *  from session.machineId -> the store's machines list (the client's live
   *  MachineWire.online), NOT from the frozen transcript flag — so it appears
   *  when the machine drops and clears when it returns without any re-read. */
  presenceOfflineMachineName: string | null
  livePendingAskIndex: number
  /** The live question drawn from agent state, for the window where the
   *  transcript has no item for it yet — see `pendingAskFromState`. Null
   *  whenever the transcript can speak for itself. */
  pendingAskBlock: ChatBlock | null
  lastAnswerBlockIndex: number
  lastAnswerText: string
  isOperatorPromptRow: (row: ChatRow) => boolean
  stickyEnabled: boolean
  /** The session's ACTOR + ON-BEHALF-OF pairs, one per role (doc §3.1.3 A3). */
  attribution: TranscriptAttributionTable

  /** True while runs should render already unfolded. Always false since
   *  POD-993 retired the detail switcher; kept as a prop so the feed's own
   *  contract does not change shape if a per-run "expand all" returns. */
  expandRuns: boolean

  // -- search ----------------------------------------------------------------
  query: string
  setQuery: (q: string) => void
  search: TranscriptSearchState
  moveMatchCursor: (delta: number) => void
  /** True while the query's window deepen is still reading — the count beside the
   *  query is over a still-growing window, and the bar marks it as provisional. */
  deepeningSearch: boolean

  // -- composing and sending -------------------------------------------------
  setDraft: (text: string) => void
  composer: ComposerState
  attachments: UseAttachmentsResult
  isMobile: boolean
  taRef: RefObject<HTMLTextAreaElement | null>
  submitDraft: (draft: string) => void
  pending: readonly PendingItem[]
  ctxSeq: number | null
  offer: SessionView['offer'] | null
  sendOfferPrompt: (prompt: string, offerAt: string) => Promise<void>
  /** Decline the offer without answering it — the conversation model. */
  dismissOffer: (offerAt: string) => Promise<void>
  retractQueuedMessage: (id: string) => Promise<void>
  /** "not sent — retry" on a bubble the outbox gave up on: the same message,
   *  under its own id (POD-4762). */
  retryPending: (id: string) => Promise<void>
  /** "not sent — discard": drop the copy the app still holds; on a message the
   *  server says did not arrive, dismiss its notice. */
  discardPending: (id: string) => Promise<void>
  /** "Send again": the text back in the composer, to go as a NEW message. */
  sendAgain: (id: string) => Promise<void>
  answerInteractionId?: string
  answerAsk: (answer: import('./AskUserQuestionCard').AskUserQuestionAnswer) => Promise<void>
  activity: ChatActivity | null

  // -- headless superagent routing -------------------------------------------
  headlessTurn: { turnRunning: boolean; overlay: HeadlessOverlay | null; turnError: string | null; restoredFailure: import('@podium/client-core/api').SuperagentTurnFailure | null }
  /** The in-progress half of the open turn (POD-2293): text still being written
   *  and tools still running, for sessions whose driver publishes fragments.
   *  Null for everyone else — a PTY chat is untouched. */
  turnPreview: TurnPreview | null
  /** A turn is running: show the stop control. */
  turnActive: boolean
  /** A stop may be attempted: arm the chord and enable the control. */
  canInterrupt: boolean
  interrupt: (draft: string) => void
  /** Why the last stop did NOT happen, for the composer's notice row. Null once
   *  a stop is attempted again or the view moves to another session. */
  interruptError: string | null
  /** The thread's harness + model + effort, for the prompt box's pickers
   *  (POD-782). `agentKind` undefined = Auto (follow Settings). */
  backend: { agentKind: string | undefined; model: string; effort: string }
  setBackendModel: (model: string, agentKind?: string) => void
  setBackendEffort: (effort: string) => void

  // -- scrolling -------------------------------------------------------------
  scrollerRef: RefObject<HTMLDivElement | null>
  scroll: UseTranscriptScrollResult
  visibleRows: ChatRow[]
  /** Absolute row temporarily revealed by an external transcript jump. */
  revealedRow: number | undefined

  // -- misc UI ---------------------------------------------------------------
  lightbox: string | null
  setLightbox: (url: string | null) => void
  openFile: (sessionId: SessionId, path: string) => void
  tldr: () => void
}

const LAYOUT_ACTIONS = ['trpc', 'openFile', 'httpOrigin', 'tldrSession', 'clearAttachedSession', 'clearTranscriptReveal'] as const

export function useChatLayout(opts: UseChatLayoutOptions): ChatSurface {
  const { conversation } = opts
  const view = conversation.presentation
  const {
    sessionId,
    active,
    superThread,
    compact,
  } = opts

  const { trpc, openFile, httpOrigin, tldrSession, clearAttachedSession, clearTranscriptReveal } = useRuntimeActions(LAYOUT_ACTIONS)
  const session = useChatSession(sessionId)
  const presenceOfflineMachineName = useChatMachinePresence(session, active)
  const sessionExitKind = useChatSessionExitKind(sessionId)
  const { attachedSessionId, transcriptReveal } = useChatContextWindow()

  // The chat's referent, resolved over a PARTIAL world. `exitKind` is optional
  // on the replica CONTRACT (POD-1510) — test fakes and the legacy TanStack
  // replica do not implement it — and its absence means "no exit record", which
  // resolves to `pending`, never to a fabricated deletion. The structural cast
  // this used to carry is gone: the contract declares the method now, so the
  // optional call is checked rather than asserted.
  const reference = useMemo(
    () => chatSessionReference(sessionId, session ? [session] : [], () => sessionExitKind),
    [sessionId, session, sessionExitKind],
  )
  const cwd = session?.cwd ?? '/'
  const headless = superThread !== undefined || session?.headless === true

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [followTail, setFollowTail] = useState(true)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const query = view.query
  const stickyPrompts = useStickyPromptsPreference()
  // The superagent side panel is too short to give a pinned prompt anywhere to
  // go, so sticky questions are suppressed there regardless of the preference.
  const stickyEnabled = stickyPrompts.enabled && !compact

  const { blocks, rows, visibleRows, renderStart, deepeningSearch, computeReady, markdownHtml } = view
  const log = conversation.transcript
  const { loadingOlder, initialLoaded } = log
  const moreAbove = renderStart > 0 || (log.hasMoreOlder && log.head !== undefined)
  const loadOlder = useCallback(() => { void view.loadOlder().catch(() => {}) }, [view])
  const setRenderCount = view.setRenderCount
  const search = view.search
  useEffect(() => view.setFollowTail(followTail), [view, followTail])

  // Operator-prompt recognition needs the message-envelope parser, which is a
  // web module; the slice takes it as an injected resolver so the predicate has
  // ONE definition rather than one per platform.
  const promptOptions = useMemo<OperatorPromptOptions>(
    () => ({
      collapseMachineContext: headless,
      operatorTextOf: (text: string) => parseEnvelopeBatch(text)?.operatorText,
    }),
    [headless],
  )
  const isOperatorPromptRow = useCallback(
    (row: ChatRow) => isOperatorPromptRowOf(row, promptOptions),
    [promptOptions],
  )

  const rowsToRender = useMemo(
    () => renderableRows({ rows, visibleRows, renderStart, stickyEnabled, promptOptions }),
    [rows, visibleRows, renderStart, stickyEnabled, promptOptions],
  )
  const livePendingAskIndex = useMemo(
    () => livePendingAskIndexOf(blocks, session?.status),
    [blocks, session?.status],
  )
  // A question Claude Code has not written down yet. Only ever consulted when
  // the transcript has no pending ask of its own, so the real item takes over
  // the moment it lands.
  const need = session?.agentState?.need
  const pendingAskBlock = useMemo(
    () =>
      pendingAskFromState(
        need,
        session?.status,
        session?.agentState?.phase,
        livePendingAskIndex >= 0,
      ),
    [need, session?.status, session?.agentState?.phase, livePendingAskIndex],
  )
  const answer = useMemo(() => lastAnswerOf(blocks), [blocks])
  // Derived once per session, not once per row: the pair depends on the row's
  // ROLE and the session and on nothing else, so three stable objects serve the
  // whole transcript and the memoized block views keep skipping renders.
  const attribution = useMemo(() => transcriptAttributionTable(session), [session])

  const scroll = useTranscriptScroll({
    sessionId,
    scrollerRef,
    active,
    blockCount: blocks.length,
    renderStart,
    stickyEnabled,
    moreAbove,
    loadingOlder,
    loadOlder,
    rowsToRender,
    onFollowChange: setFollowTail,
  })
  const revealLoadOlder = scroll.loadOlder
  const revealScrollToBlock = scroll.scrollToBlock

  // A Handoff card carries the transcript item's stable cursor/id, not a row
  // number. The reveal consumer owns paging, window expansion and the centered
  // scroll while this surface continues to own transcript data and geometry.
  const revealedRow = useTranscriptReveal({
    active,
    sessionId,
    request: transcriptReveal,
    blocks,
    rows,
    initialLoaded,
    computeReady,
    loadingOlder,
    moreAbove,
    renderStart,
    setRenderCount,
    loadOlder: revealLoadOlder,
    scrollToBlock: revealScrollToBlock,
    clear: clearTranscriptReveal,
  })

  const setBackendModel = conversation.setBackendModel
  const setBackendEffort = conversation.setBackendEffort
  const headlessTurn = {
    get turnRunning() { return conversation.turnRunning },
    get overlay() { return conversation.headless },
    get turnError() { return conversation.turnError ?? conversation.visibleFailure?.error ?? null },
    get restoredFailure() { return conversation.visibleFailure },
  }

  const attachments = useAttachments({ sessionId, trpc })

  const sends = conversation.sends
  const send = useMemo(() => ({
    get ready() { return conversation.ready },
    get pending(): PendingItem[] { return sends.bubbles.map(bubble => bubble.error === undefined ? bubble : { ...bubble, failure: bubble.notice !== undefined || bubble.error.startsWith('not sent') ? bubble.error : `not delivered — ${bubble.error}` }) },
    get justSent() { return sends.justSent },
    get ctxSeq() { return conversation.ctxSeq },
    get offer() { return sends.offer },
    get canInterrupt() { return sends.canInterrupt },
    get interruptError() { return sends.interruptError },
    setDraft: (text: string) => { conversation.draft = text },
    send: async (text: string, tags?: PendingItem['tags'], toolPaths?: string[], attachments?: readonly import('@podium/protocol/daemon').RuntimeAttachmentRef[]) => {
      scroll.pinToBottom()
      await sends.submit({ text, wire: text, tags, toolPaths, attachments })
    },
    sendOfferPrompt: async (prompt: string, at: string) => { scroll.pinToBottom(); await sends.sendOffer(prompt, at) },
    dismissOffer: sends.dismissOffer.bind(sends),
    retractQueuedMessage: sends.retract.bind(sends),
    retryPending: sends.retry.bind(sends),
    discardPending: sends.discard.bind(sends),
    sendAgain: sends.sendAgain.bind(sends),
    interrupt: sends.interrupt.bind(sends),
  }), [conversation, sends, scroll.pinToBottom])

  const phase = transcriptPhase({ reference, blockCount: blocks.length, pendingCount: conversation.hasPending ? 1 : 0, initialLoaded: initialLoaded && computeReady })

  // Draft: read from the store, written through the actions seam (POD-402) —
  // one call, no merge. See ChatComposer's header for the classification and why
  // this stays a single action rather than becoming view-side reconciliation.
  const setDraft = send.setDraft

  const submitDraft = useCallback(
    (draft: string) => {
      const text = draft.trim()
      const { paths, legacyPaths, refs, tags } = attachments.ready()
      if (!text && paths.length === 0) return
      if (attachments.uploading) return
      conversation.rememberPrompt(text)
      attachments.clearReady()
      void send.send(
        legacyPaths.length > 0 ? [legacyPaths.join('\n'), text].filter(Boolean).join('\n') : text,
        tags.length > 0 ? tags : undefined,
        paths.length > 0 ? paths : undefined,
        refs.length > 0 ? refs : undefined,
      )
    },
    [attachments, send, conversation],
  )

  /**
   * Is a turn running, as far as this client can tell? Drives the VISIBLE stop
   * control, which should not sit on the floor of an idle composer.
   */
  const interrupt = useCallback(
    (draft: string) => {
      taRef.current?.focus()
      void send.interrupt(draft)
    },
    [send],
  )

  // Answer a live AskUserQuestion from its chat card: option digits, free text
  // via the native Other entry, or skip (Esc). The server types the matching
  // keystrokes into the agent's native menu. Memoized so its identity stays
  // stable — ChatBlockView is memo'd and a fresh callback each render would
  // defeat that for every block. Who answered is the authority's to stamp
  // (doc §3.1.3 A3); the payload carries only the answer shape.
  const { question: currentQuestion } = useChatInteractions(sessionId)
  const answerAsk = useMemo(
    () => async (answer: import('./AskUserQuestionCard').AskUserQuestionAnswer) => {
      if (
        currentQuestion &&
        (answer.interactionId !== currentQuestion.id ||
          !answer.question ||
          !matchesQuestionInteraction(currentQuestion, answer.question))
      ) {
        throw new Error('The question changed; wait for the current menu.')
      }
      // A refused answer must reach the card. The server types nothing when it
      // cannot express a choice as keystrokes, and a resolved promise there
      // would show the operator "sent" over a question still on screen — the
      // silent substitution POD-770 was about, one layer up.
      const sent = (await trpc.sessions.answerAskUserQuestion.mutate(
        'skip' in answer
          ? { sessionId, interactionId: answer.interactionId, skip: true }
          : { sessionId, interactionId: answer.interactionId, choices: answer.choices },
      )) as { ok?: boolean; reason?: string } | undefined
      if (sent?.ok === false) throw new Error(sent.reason ?? 'answer not delivered')
    },
    [trpc, sessionId, currentQuestion],
  )

  // Searching matches over LOADED blocks, and the initial window is sized for a
  // fast first paint rather than for recall [POD-1631] — so the first keystroke of
  // a query deepens the loaded window back to search depth. Off the paint path and
  // idempotent per session: a non-searching open never pays for it.
  const setQuery = view.setQuery
  const moveMatchCursor = view.moveCursor

  // Jump to the active search match. A match can sit ABOVE the rendered window
  // (search runs over all loaded blocks, the DOM holds only the trailing window),
  // so first widen the window to include it, then scroll a frame later once its
  // node has mounted. (Matches still only span LOADED blocks — see the Minimap
  // note on paged-in-on-demand history.)
  const activeRow = search.activeRow
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolling is the effect of cursor moves
  useEffect(() => {
    if (activeRow === undefined) return
    if (activeRow < renderStart) {
      // The matched row sits above the rendered window. Reveal enough trailing
      // rows to cover it, then scroll a frame later once its node has mounted (no
      // scroll-anchor — this is an explicit jump, not a position-preserving prepend).
      setRenderCount(rows.length - activeRow + RENDER_WINDOW)
      requestAnimationFrame(() => scroll.scrollToBlock(activeRow))
    } else {
      scroll.scrollToBlock(activeRow)
    }
  }, [activeRow])

  const isMobile = useIsMobile()
  const tldr = useCallback(
    () => void tldrSession(sessionId, lastAnswerOf(view.result?.blocks ?? []).text),
    [tldrSession, sessionId, view],
  )

  // "ASK SUPERAGENT (BTW)", MADE VISIBLE (POD-1069). The attachment is a
  // one-shot rider on the next turn, so the composer has to SAY it is there —
  // otherwise the menu item reads as a no-op that merely opened the dock, which
  // is close to what the broken version actually did.
  //
  // Scoped to the superagent's own chat: the store field is one field for the
  // app, and a chip on an ordinary session's composer would name context that
  // composer will never send.
  const attachedSession = useChatSession(attachedSessionId ?? undefined)
  const attached = useMemo(
    () =>
      superThread && attachedSessionId
        ? {
            sessionId: attachedSessionId,
            // The id is a poor last resort but an honest one: the row may not
            // have reached this client yet, and a chip that renders nothing
            // would say the attachment failed.
            label: attachedSession?.name ?? attachedSession?.title ?? attachedSessionId,
            clear: clearAttachedSession,
          }
        : null,
    [superThread, attachedSessionId, attachedSession, clearAttachedSession],
  )

  return {
    conversation,
    attached,
    get session() { return conversation.session },
    reference,
    gone: phase === 'gone',
    cwd,
    headless,
    compact,
    httpOrigin,

    blocks,
    rows,
    rowsToRender,
    renderStart,
    markdownHtml,
    phase,
    get transcriptFreshness() { return log.freshness },
    moreAbove,
    loadingOlder,
    loadOlder: scroll.loadOlder,
    get offlineAsOf() { return log.offlineAsOf },
    get offlineMachineName() { return log.offlineMachineName },
    presenceOfflineMachineName,
    livePendingAskIndex,
    pendingAskBlock,
    lastAnswerBlockIndex: answer.blockIndex,
    lastAnswerText: answer.text,
    isOperatorPromptRow,
    stickyEnabled,
    attribution,

    /** Runs render folded; a reader who wants one open clicks it. */
    expandRuns: false,

    query,
    setQuery,
    search,
    moveMatchCursor,
    deepeningSearch,

    setDraft,
    get composer() {
      const composer = composerState({ session: conversation.session, headless, turnRunning: conversation.turnRunning, compact })
      return conversation.ready ? composer : { ...composer, deliverable: false, sendable: false }
    },
    attachments,
    isMobile,
    taRef,
    submitDraft,
    get pending() { return send.pending },
    get ctxSeq() { return send.ctxSeq },
    get offer() { return headless ? null : send.offer },
    sendOfferPrompt: send.sendOfferPrompt,
    dismissOffer: send.dismissOffer,
    retractQueuedMessage: send.retractQueuedMessage,
    retryPending: send.retryPending,
    discardPending: send.discardPending,
    sendAgain: send.sendAgain,
    answerAsk,
    answerInteractionId: currentQuestion?.id,
    get activity() { return chatActivityState({ session, headless, turnRunning: conversation.turnRunning, justSent: sends.justSent }) },

    headlessTurn,
    get turnPreview() { return conversation.preview },
    get turnActive() { return headless ? conversation.turnRunning : (session !== undefined && isAgentComputing(session)) || send.justSent },
    get canInterrupt() { return send.canInterrupt },
    interrupt,
    get interruptError() { return send.interruptError },
    get backend() { return conversation.backend },
    setBackendModel,
    setBackendEffort,

    scrollerRef,
    scroll,
    visibleRows,
    revealedRow,

    lightbox,
    setLightbox,
    openFile,
    tldr,
  }
}

/** Presence follows only the addressed machine while the panel is visible. */
export function useChatMachinePresence(session: SessionView | undefined, active: boolean): string | null {
  const machine = usePoolMachine(active ? session?.machineId : undefined)
  return machine && isMachineOfflineForLiveTerminal(machine)
    ? session?.machineName ?? machine.name ?? session?.machineId ?? null : null
}
