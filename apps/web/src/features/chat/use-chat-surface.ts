import { shallowEqual } from '@podium/client-core/store'
import {
  type ChatActivity,
  type ChatRow,
  type ChatSessionReference,
  type ChatVerbosity,
  type ComposerState,
  chatActivityState,
  chatSessionReference,
  composerState,
  isOperatorPromptRow as isOperatorPromptRowOf,
  lastAnswer as lastAnswerOf,
  livePendingAskIndex as livePendingAskIndexOf,
  type OperatorPromptOptions,
  parseEnvelopeBatch,
  queuedState,
  type RenderableRow,
  renderableRows,
  type SuperThreadRef,
  type TranscriptAttributionTable,
  type TranscriptPhase,
  type TranscriptSearchState,
  transcriptAttributionTable,
  transcriptPhase,
  transcriptSearchState,
  visibleOffer,
} from '@podium/client-core/viewmodels'
import type { SessionId, SessionMeta } from '@podium/model'
import { useVoiceInput } from '@podium/terminal-client-react'
import type { RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { useChatVerbosityPreference } from '@/lib/chat-verbosity'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { useStickyPromptsPreference } from '@/lib/sticky-prompts'
import type { PendingItem, QueuedChatMessage } from './chat'
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
 *  - the STORE (sessions, drafts, the actions seam, the principal's superagent
 *    threads), read through one selector;
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

  // -- the transcript --------------------------------------------------------
  blocks: ReturnType<typeof useTranscriptWindow>['blocks']
  rows: ChatRow[]
  rowsToRender: readonly RenderableRow[]
  phase: TranscriptPhase
  moreAbove: boolean
  loadingOlder: boolean
  loadOlder: () => void
  offlineAsOf: number | null
  livePendingAskIndex: number
  lastAnswerBlockIndex: number
  lastAnswerText: string
  isOperatorPromptRow: (row: ChatRow) => boolean
  stickyEnabled: boolean
  /** The session's ACTOR + ON-BEHALF-OF pairs, one per role (doc §3.1.3 A3). */
  attribution: TranscriptAttributionTable

  // -- verbosity (POD-376) ----------------------------------------------------
  /** The STORED preference, which the control renders. The EFFECTIVE verbosity
   *  can differ: a search query overrides `summary` so a hit is never hidden. */
  verbosity: ChatVerbosity
  setVerbosity: (v: ChatVerbosity) => void
  /** True while runs should render already unfolded. */
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
  draft: string
  setDraft: (text: string) => void
  composer: ComposerState
  attachments: UseAttachmentsResult
  voice: ReturnType<typeof useVoiceInput>
  isMobile: boolean
  taRef: RefObject<HTMLTextAreaElement | null>
  submit: () => void
  pending: readonly PendingItem[]
  restoredQueued: readonly QueuedChatMessage[]
  queuedTotal: number
  ctxSeq: number | null
  offer: SessionMeta['offer'] | null
  sendOfferPrompt: (prompt: string, offerAt: string) => Promise<void>
  answerAsk: (choices: { optionIndices: number[] }[]) => Promise<void>
  activity: ChatActivity | null

  // -- headless superagent routing -------------------------------------------
  headlessTurn: UseHeadlessTurnResult
  canInterrupt: boolean

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
    sessions,
    drafts,
    setSessionDraft,
    resumeAndSend,
    openFile,
    httpOrigin,
    tldrSession,
    getUserFocus,
    issues,
    superThreads,
  } = useStoreSelector(
    (s) => ({
      hub: s.hub,
      trpc: s.trpc,
      replica: s.replica,
      sessions: s.sessions,
      drafts: s.drafts,
      setSessionDraft: s.setSessionDraft,
      resumeAndSend: s.resumeAndSend,
      openFile: s.openFile,
      httpOrigin: s.httpOrigin,
      tldrSession: s.tldrSession,
      getUserFocus: s.getUserFocus,
      issues: s.issues,
      superThreads: s.superThreads,
    }),
    shallowEqual,
  )

  // The chat's referent, resolved over a PARTIAL world. `exitKind` is optional
  // on the replica CONTRACT (POD-1510) — test fakes and the legacy TanStack
  // replica do not implement it — and its absence means "no exit record", which
  // resolves to `pending`, never to a fabricated deletion. The structural cast
  // this used to carry is gone: the contract declares the method now, so the
  // optional call is checked rather than asserted.
  const reference = useMemo(
    () => chatSessionReference(sessionId, sessions, (id) => replica?.exitKind?.('session', id)),
    [sessionId, sessions, replica],
  )
  const session = reference.value
  const cwd = session?.cwd ?? '/'
  const headless = session?.headless === true

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [query, setQueryState] = useState('')
  const [matchCursor, setMatchCursor] = useState(0)

  const stickyPrompts = useStickyPromptsPreference()
  // The superagent side panel is too short to give a pinned prompt anywhere to
  // go, so sticky questions are suppressed there regardless of the preference.
  const stickyEnabled = stickyPrompts.enabled && !compact

  // Transcript verbosity (POD-376). SEARCH OVERRIDES SUMMARY: a query the reader
  // typed is a request to find something, and hiding the rows it could be in
  // would answer "no matches" for work that is right there. This mirrors what
  // search already does to the fold (auto-expands a run) and to the prompt clamp
  // (yields so the hit is visible) — one rule, three places.
  const chatVerbosity = useChatVerbosityPreference()
  const verbosity: ChatVerbosity =
    query && chatVerbosity.verbosity === 'summary' ? 'normal' : chatVerbosity.verbosity

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
  } = useTranscriptWindow({
    sessionId,
    hub,
    trpc,
    replica,
    active,
    session,
    scrollerRef,
    verbosity,
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
  const search = useMemo(
    () => transcriptSearchState({ blocks, rows, query, cursor: matchCursor }),
    [blocks, rows, query, matchCursor],
  )
  const livePendingAskIndex = useMemo(
    () => livePendingAskIndexOf(blocks, session?.status),
    [blocks, session?.status],
  )
  const answer = useMemo(() => lastAnswerOf(blocks), [blocks])
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

  const headlessTurn = useHeadlessTurn({
    sessionId,
    hub,
    trpc,
    headless,
    superThread,
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
    getUserFocus,
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
        initialLoaded,
      }),
    [reference, blocks.length, send.pending.length, initialLoaded],
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
  const draft = drafts[sessionId] ?? ''
  const setDraft = useCallback(
    (text: string) => setSessionDraft(sessionId, text),
    [setSessionDraft, sessionId],
  )
  const voice = useVoiceInput((text) => setDraft(draft ? `${draft} ${text}` : text))

  const submit = useCallback(() => {
    const text = draft.trim()
    const { paths, tags } = attachments.ready()
    if (!text && paths.length === 0) return
    if (attachments.uploading) return
    setDraft('')
    attachments.clear()
    void send.send(
      paths.length > 0 ? `${paths.join('\n')}\n${text}` : text,
      tags.length > 0 ? tags : undefined,
      paths.length > 0 ? paths : undefined,
    )
  }, [draft, attachments, setDraft, send])

  // Answer a live AskUserQuestion from its chat card: send the chosen 1-based
  // option index per question to the server, which types the matching digit(s)
  // into the agent's native menu. Memoized so its identity stays stable —
  // ChatBlockView is memo'd and a fresh callback each render would defeat that
  // for every block. The payload carries choices and nothing else: who answered
  // is the authority's to stamp (doc §3.1.3 A3).
  const answerAsk = useMemo(
    () => async (choices: { optionIndices: number[] }[]) => {
      await trpc.sessions.answerAskUserQuestion.mutate({ sessionId, choices })
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

  return {
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
    phase,
    moreAbove,
    loadingOlder,
    loadOlder,
    offlineAsOf,
    livePendingAskIndex,
    lastAnswerBlockIndex: answer.blockIndex,
    lastAnswerText: answer.text,
    isOperatorPromptRow,
    stickyEnabled,
    attribution,

    /** The stored preference and its setter — NOT the effective `verbosity`
     *  above, which search may have overridden. The control must show what the
     *  reader chose, or toggling search would look like it changed the setting. */
    verbosity: chatVerbosity.verbosity,
    setVerbosity: chatVerbosity.setVerbosity,
    /** True while a run should render already-unfolded. */
    expandRuns: verbosity === 'verbose',

    query,
    setQuery,
    search,
    moveMatchCursor,
    deepeningSearch,

    draft,
    setDraft,
    composer,
    attachments,
    voice,
    isMobile,
    taRef,
    submit,
    pending: send.pending,
    restoredQueued: queued.restored,
    queuedTotal: queued.total,
    ctxSeq: send.ctxSeq,
    offer,
    sendOfferPrompt: send.sendOfferPrompt,
    answerAsk,
    activity,

    headlessTurn,
    canInterrupt: superThread !== undefined,

    scrollerRef,
    scroll,
    visibleRows,

    lightbox,
    setLightbox,
    openFile,
    tldr,
  }
}
