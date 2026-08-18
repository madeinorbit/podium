import { shallowEqual } from '@podium/client-core/store'
import {
  type AskAnswerChoice,
  type ChatActivity,
  type ChatRow,
  type ChatSessionReference,
  type ChatVerbosity,
  type ComposerState,
  chatActivityState,
  chatSessionReference,
  composerState,
  isOperatorPrompt as isOperatorPromptOf,
  isOperatorPromptRow as isOperatorPromptRowOf,
  lastAnswer as lastAnswerOf,
  livePendingAskIndex as livePendingAskIndexOf,
  type OperatorPromptOptions,
  parseEnvelopeBatch,
  pendingAskFromState,
  queuedState,
  type RenderableRow,
  renderableRows,
  type SuperThreadRef,
  type TranscriptAttributionTable,
  type TranscriptPhase,
  type TranscriptSearchState,
  transcriptAttributionTable,
  transcriptPhase,
  visibleOffer,
} from '@podium/client-core/viewmodels'
import { isAgentComputing, type SessionId, type SessionMeta } from '@podium/model/browser'
import type { RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession, useSessionExitKind, useStoreSelector } from '@/app/store'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { useStickyPromptsPreference } from '@/lib/sticky-prompts'
import type { ChatBlock, PendingItem, QueuedChatMessage } from './chat'
import { type UseAttachmentsResult, useAttachments } from './use-attachments'
import { useChatSend } from './use-chat-send'
import { type UseHeadlessTurnResult, useHeadlessTurn } from './use-headless-turn'
import { type UseTranscriptScrollResult, useTranscriptScroll } from './use-transcript-scroll'
import { RENDER_WINDOW, useTranscriptWindow } from './useTranscriptWindow'

/**
 * THE CHAT SOURCE (POD-405) — the one place the chat surface's data is
 * assembled, so `ChatView` can be a shell.
 *
 * Three inputs meet here and nowhere else:
 *
 *  - the STORE (the addressed session, actions seam, and the principal's
 *    superagent threads), read through keyed/scalar selectors;
 *  - the TRANSCRIPT WINDOW (`useTranscriptWindow`: the disk read, the live tail,
 *    back-paging and the bounded render window);
 *  - the CHAT SLICE (`@podium/client-core/viewmodels`), which answers every
 *    view-model question over those two as pure functions.
 *
 * Nothing here derives. Every `useMemo` below is a call INTO the slice, kept
 * memoized only so React can skip work — delete the memo and the answers are
 * identical, which is the property that makes the slice the single definition.
 *
 * The parts with their own lifecycles (headless turn routing, sending and
 * pending reconciliation, attachments, scroll anchoring) are their own hooks;
 * this composes them and hands the shell one object.
 */

/** The reason inside a `{ ok: false, reason }` reply, or null for anything else.
 *  Session writes that the substrate REFUSES resolve 200 with that shape rather
 *  than throwing — see `assert-send-accepted.ts` for the same idiom on sends. */
function refusalReason(result: unknown): string | null {
  if (result === null || typeof result !== 'object') return null
  if (!('ok' in result) || (result as { ok: unknown }).ok !== false) return null
  const reason = (result as { reason?: unknown }).reason
  return typeof reason === 'string' && reason !== '' ? reason : 'the agent refused the interrupt'
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface UseChatSurfaceOptions {
  sessionId: SessionId
  active: boolean
  superThread: SuperThreadRef | undefined
  compact: boolean
  initialTurnRunning: boolean
  initialPendingText: string | undefined
}

export interface ChatSurface {
  // -- identity and the partial world ----------------------------------------
  session: SessionMeta | undefined
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
  blocks: ReturnType<typeof useTranscriptWindow>['blocks']
  rows: ChatRow[]
  rowsToRender: readonly RenderableRow[]
  /** First windowed-in row: the base every rendered `[data-block]` index is
   *  absolute against, and what `visibleRows[0]` actually is. */
  renderStart: number
  /** Unsafe worker HTML keyed by source Markdown; TranscriptFeed sanitizes it. */
  markdownHtml: ReadonlyMap<string, string>
  phase: TranscriptPhase
  moreAbove: boolean
  loadingOlder: boolean
  loadOlder: () => void
  offlineAsOf: number | null
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
  restoredQueued: readonly QueuedChatMessage[]
  ctxSeq: number | null
  offer: SessionMeta['offer'] | null
  sendOfferPrompt: (prompt: string, offerAt: string) => Promise<void>
  /** Decline the offer without answering it — see `useChatSend`. */
  dismissOffer: (offerAt: string) => Promise<void>
  retractQueuedMessage: (id: string) => Promise<void>
  answerAsk: (answer: import('./AskUserQuestionCard').AskUserQuestionAnswer) => Promise<void>
  activity: ChatActivity | null

  // -- headless superagent routing -------------------------------------------
  headlessTurn: UseHeadlessTurnResult
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

  // -- misc UI ---------------------------------------------------------------
  lightbox: string | null
  setLightbox: (url: string | null) => void
  openFile: (sessionId: SessionId, path: string) => void
  tldr: () => void
}

export function useChatSurface(opts: UseChatSurfaceOptions): ChatSurface {
  const { sessionId, active, superThread, compact, initialTurnRunning, initialPendingText } = opts

  const {
    hub,
    trpc,
    replica,
    setSessionDraft,
    resumeAndSend,
    dismissOffer,
    setPanelMode,
    openFile,
    httpOrigin,
    tldrSession,
    getUserFocus,
    attachedSessionId,
    clearAttachedSession,
    issues,
    superThreads,
  } = useStoreSelector(
    (s) => ({
      hub: s.hub,
      trpc: s.trpc,
      replica: s.replica,
      setSessionDraft: s.setSessionDraft,
      resumeAndSend: s.resumeAndSend,
      dismissOffer: s.dismissOffer,
      setPanelMode: s.setPanelMode,
      openFile: s.openFile,
      httpOrigin: s.httpOrigin,
      tldrSession: s.tldrSession,
      getUserFocus: s.getUserFocus,
      attachedSessionId: s.attachedSessionId,
      clearAttachedSession: s.clearAttachedSession,
      issues: s.issues,
      superThreads: s.superThreads,
    }),
    shallowEqual,
  )
  const session = useSession(sessionId)
  const sessionExitKind = useSessionExitKind(sessionId)

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
  const headless = session?.headless === true

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [query, setQueryState] = useState('')
  const [matchCursor, setMatchCursor] = useState(0)
  const lastSubmittedPromptRef = useRef<string | null>(initialPendingText ?? null)

  // A mobile AgentPanel reuses one ChatView while switching sessions.
  // Recollection is per-session; a stopped turn must never pull another
  // session's prompt into this composer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear on session switch
  useEffect(() => {
    lastSubmittedPromptRef.current = initialPendingText ?? null
  }, [sessionId, initialPendingText])

  const stickyPrompts = useStickyPromptsPreference()
  // The superagent side panel is too short to give a pinned prompt anywhere to
  // go, so sticky questions are suppressed there regardless of the preference.
  const stickyEnabled = stickyPrompts.enabled && !compact

  // TRANSCRIPT DETAIL IS NOT A SETTING ANY MORE (POD-993). It was three levels
  // behind a rail popover — summary / normal / verbose — and normal was both the
  // default and the one anybody used; the other two were a control the reader
  // met once and then carried forever, with a search-override rule attached to
  // keep `summary` from hiding its own hits. The feed renders `normal`, always,
  // and a run that a reader wants opened is opened by clicking it. The plumbing
  // below still takes the value because the compute worker is written in terms
  // of it — one constant, one place.
  const verbosity: ChatVerbosity = 'normal'

  const {
    blocks,
    rows,
    visibleRows,
    renderStart,
    moreAbove,
    loadingOlder,
    deepeningSearch,
    initialLoaded,
    offlineAsOf,
    loadOlder,
    ensureSearchDepth,
    setRenderCount,
    pinnedToBottom,
    didInitialScroll,
    prependAnchor,
    search,
    markdownHtml,
    computeReady,
  } = useTranscriptWindow({
    sessionId,
    hub,
    trpc,
    replica,
    active,
    session,
    scrollerRef,
    verbosity,
    query,
    cursor: matchCursor,
  })

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
  const latestOperatorPrompt = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const item = blocks[i]?.item
      if (!item || !isOperatorPromptOf(item, promptOptions)) continue
      return parseEnvelopeBatch(item.text)?.operatorText ?? item.text
    }
    return null
  }, [blocks, promptOptions])
  // Derived once per session, not once per row: the pair depends on the row's
  // ROLE and the session and on nothing else, so three stable objects serve the
  // whole transcript and the memoized block views keep skipping renders.
  const attribution = useMemo(() => transcriptAttributionTable(session), [session])

  const scroll = useTranscriptScroll({
    scrollerRef,
    active,
    blockCount: blocks.length,
    renderStart,
    stickyEnabled,
    moreAbove,
    loadOlder,
    pinnedToBottom,
    didInitialScroll,
    prependAnchor,
    rowsToRender,
  })

  // THE THREAD'S BACKEND (POD-782) — what the prompt box's two pills read and
  // write. The stored value lives on the thread (so it survives a reload and is
  // the same on every client), and a fresh pick is held locally until the send
  // that carries it lands, which is what lets picking and sending be one act
  // rather than a settings detour.
  const superThreadRow = useMemo(
    () => (superThread ? superThreads?.find((t) => t.id === superThread.threadId) : undefined),
    [superThreads, superThread],
  )
  const [backendPick, setBackendPick] = useState<{
    agentKind?: string | null
    model?: string
    effort?: string
  }>({})
  const backend = useMemo(() => {
    const model = backendPick.model ?? superThreadRow?.model ?? 'auto'
    // A model override pins the connector it was picked from. Auto (no model)
    // follows Settings, so the rail does not pretend a frozen harness is a
    // choice — the menu still lists every connector.
    const agentKind =
      backendPick.agentKind !== undefined
        ? (backendPick.agentKind ?? undefined)
        : model !== 'auto'
          ? superThreadRow?.agentKind
          : undefined
    return {
      agentKind,
      model,
      effort: backendPick.effort ?? superThreadRow?.effort ?? 'auto',
    }
  }, [superThreadRow, backendPick])
  const setBackendModel = useCallback((model: string, agentKind?: string) => {
    // Effort is scoped to the model (a model can narrow the ladder or support
    // none), so changing the model resets it — as every other picker pair does.
    setBackendPick((p) => ({
      ...p,
      model,
      agentKind: model === 'auto' ? null : (agentKind ?? p.agentKind),
      effort: 'auto',
    }))
  }, [])
  const setBackendEffort = useCallback((effort: string) => {
    setBackendPick((p) => ({ ...p, effort }))
  }, [])

  const headlessTurn = useHeadlessTurn({
    sessionId,
    hub,
    trpc,
    headless,
    superThread,
    backend: { model: backend.model, effort: backend.effort, agentKind: backend.agentKind },
    initialTurnRunning,
    blockCount: blocks.length,
  })

  const composer = useMemo(
    () =>
      composerState({
        session,
        headless,
        turnRunning: headlessTurn.turnRunning,
        compact,
      }),
    [session, headless, headlessTurn.turnRunning, compact],
  )

  // Per doc §3.1.6 S2 the authority scopes `listThreads` to the caller, so the
  // store's roster IS the principal's own set. Handing the route this set is
  // what makes a foreign thread id unaddressable from the client.
  const ownThreadIds = useMemo(
    () => (superThreads ? new Set(superThreads.map((t) => t.id)) : undefined),
    [superThreads],
  )

  const attachments = useAttachments({ sessionId, trpc })

  const send = useChatSend({
    sessionId,
    trpc,
    resumeAndSend,
    dismissOffer,
    setPanelMode,
    getUserFocus,
    attachedSessionId,
    clearAttachedSession,
    issues,
    headless,
    superThread,
    compact,
    active,
    composer,
    ownThreadIds,
    blocks,
    session,
    headlessTurn,
    pinToBottom: scroll.pinToBottom,
    initialPendingText,
  })

  const queued = useMemo(
    () =>
      queuedState({
        session,
        queuedMessages: send.queuedMessages,
        pending: send.pending,
      }),
    [session, send.queuedMessages, send.pending],
  )

  const phase = useMemo(
    () =>
      transcriptPhase({
        reference,
        blockCount: blocks.length,
        pendingCount: send.pending.length,
        initialLoaded: initialLoaded && computeReady,
      }),
    [reference, blocks.length, send.pending.length, initialLoaded, computeReady],
  )

  const activity = useMemo(
    () =>
      chatActivityState({
        session,
        headless,
        turnRunning: headlessTurn.turnRunning,
        justSent: send.justSent,
      }),
    [session, headless, headlessTurn.turnRunning, send.justSent],
  )

  const offer = useMemo(
    () => visibleOffer({ session, headless, dismissedOfferAt: send.dismissedOfferAt }),
    [session, headless, send.dismissedOfferAt],
  )

  // Draft: read from the store, written through the actions seam (POD-402) —
  // one call, no merge. See ChatComposer's header for the classification and why
  // this stays a single action rather than becoming view-side reconciliation.
  const setDraft = useCallback(
    (text: string) => setSessionDraft(sessionId, text),
    [setSessionDraft, sessionId],
  )

  const submitDraft = useCallback(
    (draft: string) => {
      const text = draft.trim()
      const { paths, tags } = attachments.ready()
      if (!text && paths.length === 0) return
      if (attachments.uploading) return
      lastSubmittedPromptRef.current = text || null
      setDraft('')
      attachments.clear()
      void send.send(
        paths.length > 0 ? `${paths.join('\n')}\n${text}` : text,
        tags.length > 0 ? tags : undefined,
        paths.length > 0 ? paths : undefined,
      )
    },
    [attachments, setDraft, send],
  )

  /**
   * Is a turn running, as far as this client can tell? Drives the VISIBLE stop
   * control, which should not sit on the floor of an idle composer.
   */
  const turnActive = headless
    ? headlessTurn.turnRunning
    : (session !== undefined && isAgentComputing(session)) || send.justSent
  /**
   * May a stop be ATTEMPTED? For a native session this is LIVENESS, not the
   * observed phase (POD-1214).
   *
   * `agentState.phase` is the last thing the harness was seen doing, and the
   * observation lags the agent. Gating the chord on it meant the exact moment
   * you want out — the agent has gone quiet-but-busy, or the observer is a beat
   * behind — was the moment two Escapes did nothing at all, silently, because
   * the handler did not even take the keypress. Liveness is the honest gate:
   * whether the key can safely be delivered is the SERVER's call (it holds the
   * authoritative phase and the harness manifest), and its refusal now arrives
   * here as {@link interruptError} instead of being swallowed.
   */
  const canInterrupt = headless
    ? superThread !== undefined && headlessTurn.turnRunning
    : session !== undefined && (session.status === 'live' || session.status === 'starting')
  const [interruptError, setInterruptError] = useState<string | null>(null)
  // A refusal belongs to the session it came from — the mobile panel reuses one
  // composer across switches, and a stale "Not stopped" under another session's
  // prompt would name the wrong agent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear on session switch
  useEffect(() => setInterruptError(null), [sessionId])
  const interrupt = useCallback(
    (draft: string) => {
      if (!canInterrupt) return
      setInterruptError(null)
      // The keyboard chord is accepted only from an empty field. Keep that same
      // safety here so the stop button never overwrites a reply already in flight.
      if (draft === '') {
        const recalled = lastSubmittedPromptRef.current ?? latestOperatorPrompt
        if (recalled) setDraft(recalled)
      }
      taRef.current?.focus()
      if (headless) {
        void Promise.resolve(headlessTurn.interrupt()).catch((e: unknown) =>
          setInterruptError(errorText(e)),
        )
        return
      }
      // A refusal RESOLVES as `{ ok: false, reason }` (the `assertSendAccepted`
      // shape); only a transport failure throws. Reading just the throw is how a
      // stop that never reached the agent looked identical to one that worked.
      void Promise.resolve(trpc.sessions.interrupt.mutate({ sessionId }))
        .then((result) => {
          const refused = refusalReason(result)
          if (refused) setInterruptError(refused)
        })
        .catch((e: unknown) => setInterruptError(errorText(e)))
    },
    [canInterrupt, headless, headlessTurn, latestOperatorPrompt, sessionId, setDraft, trpc],
  )

  // Answer a live AskUserQuestion from its chat card: option digits, free text
  // via the native Other entry, or skip (Esc). The server types the matching
  // keystrokes into the agent's native menu. Memoized so its identity stays
  // stable — ChatBlockView is memo'd and a fresh callback each render would
  // defeat that for every block. Who answered is the authority's to stamp
  // (doc §3.1.3 A3); the payload carries only the answer shape.
  const answerAsk = useMemo(
    () => async (answer: import('./AskUserQuestionCard').AskUserQuestionAnswer) => {
      // A refused answer must reach the card. The server types nothing when it
      // cannot express a choice as keystrokes, and a resolved promise there
      // would show the operator "sent" over a question still on screen — the
      // silent substitution POD-770 was about, one layer up.
      const sent = (await trpc.sessions.answerAskUserQuestion.mutate(
        'skip' in answer ? { sessionId, skip: true } : { sessionId, choices: answer.choices },
      )) as { ok?: boolean; reason?: string } | undefined
      if (sent?.ok === false) throw new Error(sent.reason ?? 'answer not delivered')
    },
    [trpc, sessionId],
  )

  // Searching matches over LOADED blocks, and the initial window is sized for a
  // fast first paint rather than for recall [POD-1631] — so the first keystroke of
  // a query deepens the loaded window back to search depth. Off the paint path and
  // idempotent per session: a non-searching open never pays for it.
  const setQuery = useCallback(
    (q: string) => {
      if (q.trim() !== '') ensureSearchDepth()
      setQueryState(q)
      setMatchCursor(0)
    },
    [ensureSearchDepth],
  )
  const moveMatchCursor = useCallback(
    (delta: number) =>
      setMatchCursor((c) => (c + delta + Math.max(1, search.total)) % Math.max(1, search.total)),
    [search.total],
  )

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
    () => void tldrSession(sessionId, answer.text),
    [tldrSession, sessionId, answer.text],
  )

  // "ASK SUPERAGENT (BTW)", MADE VISIBLE (POD-1069). The attachment is a
  // one-shot rider on the next turn, so the composer has to SAY it is there —
  // otherwise the menu item reads as a no-op that merely opened the dock, which
  // is close to what the broken version actually did.
  //
  // Scoped to the superagent's own chat: the store field is one field for the
  // app, and a chip on an ordinary session's composer would name context that
  // composer will never send.
  const attachedSession = useSession(attachedSessionId ?? undefined)
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
    attached,
    session,
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
    moreAbove,
    loadingOlder,
    loadOlder,
    offlineAsOf,
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
    composer,
    attachments,
    isMobile,
    taRef,
    submitDraft,
    pending: send.pending,
    restoredQueued: queued.restored,
    ctxSeq: send.ctxSeq,
    offer,
    sendOfferPrompt: send.sendOfferPrompt,
    dismissOffer: send.dismissOffer,
    retractQueuedMessage: send.retractQueuedMessage,
    answerAsk,
    activity,

    headlessTurn,
    turnActive,
    canInterrupt,
    interrupt,
    interruptError,
    backend,
    setBackendModel,
    setBackendEffort,

    scrollerRef,
    scroll,
    visibleRows,

    lightbox,
    setLightbox,
    openFile,
    tldr,
  }
}
