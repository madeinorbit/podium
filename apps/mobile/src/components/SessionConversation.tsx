import {
  type ConversationPendingTurn,
  createConversationController,
  hubConnection,
  nativeSessionCanInterrupt,
  storeConversationOutbox,
  storeConversationRecords,
} from '@podium/client-core/conversation'
import { randomUUID } from '@podium/client-core/id'
import { useStoreHandle } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import { type SessionView, sessionValues } from '@podium/client-core/session-values'
import { shallowEqual } from '@podium/client-core/store'
import {
  createTranscriptController,
  transcriptActivitySignal,
} from '@podium/client-core/transcript'
import {
  chatActivity,
  composerState,
  defaultChatCapable,
  latestPendingQuestion,
  matchesQuestionInteraction,
  OPTIMISTIC_SEND_CEILING_MS,
  pendingAskFromState,
} from '@podium/client-core/viewmodels'
import {
  asMutationId,
  isAgentComputing,
  isMachineOfflineForLiveTerminal,
  type MessageDeliveryStatus,
} from '@podium/model'
import * as Haptics from 'expo-haptics'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AppState, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import {
  useHub,
  useIssues,
  useMachines,
  useSessionDraft,
  useSessions,
  useStoreSelector,
} from '../client/hooks'
import { useKeyboardLift } from '../hooks/useKeyboardHeight'
import { useRefreshableList } from '../hooks/useRefreshableTab'
import { chatSendTransport } from '../lib/chat-send-transport'
import { interruptSession } from '../lib/interrupt-session'
import { color, font, leading, sans, space } from '../theme/theme'
import { type AskQuestionAnswer, AskQuestionCard } from './AskQuestionCard'
import { Composer } from './Composer'
import { BootstrapCrossfade, TranscriptSkeleton } from './LaunchPlaceholders'
import { PendingInteractionBand } from './PendingInteractionBand'
import { PullToRefreshBoundary } from './PullToRefreshBoundary'
import { type LocalPendingTurn, pendingTurnOf } from './pending-delivery'
import { SessionActionCard } from './SessionActionCard'
import { MobileSessionLifecycle } from './SessionLifecycle'
import { TaskSheet } from './TaskSheet'
import { type PendingTurn, TranscriptList } from './TranscriptList'
import { type SentAttachment, useComposerAttachments } from './useComposerAttachments'
import { WorkingMark } from './WorkingMark'
import { WORKING_MARK_DOTS, workingMarkRadius } from './WorkingMark.shared'

/**
 * A pending turn plus the exact string that was put on the wire.
 *
 * Not part of {@link PendingTurn} because the transcript has no use for it: the
 * list renders prose and files, and the composed prompt is an implementation
 * detail of sending. Keeping it here means a retry re-sends what was refused
 * instead of reconstructing it.
 */

/** The session as the operator has just left it — the answered offer removed,
 *  so every derivation over it agrees with what is on screen. */
function withoutOffer(session: SessionView): SessionView {
  const { offer: _answered, ...rest } = session
  return rest as SessionView
}

/** The working mark's dot grid at rest, drawn as SVG so device fonts cannot
 * replace the braille glyph with a missing-character box. */
function RestingMark({ size = 24 }: { size?: number }) {
  const radius = workingMarkRadius(size)
  return (
    <View
      testID="resting-mark"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg viewBox="0 0 66 100" width={Math.round(size * 0.66)} height={size}>
        {WORKING_MARK_DOTS.map(([cx, cy]) => (
          <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={radius} fill={color.textMicro} />
        ))}
      </Svg>
    </View>
  )
}

/** An empty idle session asks for input; an empty working session promises the
 * transcript that is already on its way. */
function EmptyTranscript({ warming }: { warming: boolean }) {
  return (
    <View style={styles.empty} testID="transcript-empty">
      <View style={styles.emptyMark}>
        {warming ? <WorkingMark size={24} label={null} /> : <RestingMark size={24} />}
      </View>
      <Text style={styles.emptyTitle}>{warming ? 'The agent is on it' : 'Nothing here yet'}</Text>
      <Text style={styles.emptyBody}>
        {warming
          ? 'Its transcript streams in here as it works.'
          : 'Send a message below — the agent’s transcript streams in here.'}
      </Text>
    </View>
  )
}

/**
 * ONE CONVERSATION, TWO HOSTS [POD-724].
 *
 * The transcript is no longer only what a SESSION screen shows: opening a task
 * from Work now lands directly in the conversation of whoever is on it, with the
 * mission's flight deck one pull away. That gave the app two places wanting the
 * same object — the session screen and the mission screen — and the transcript
 * is not a view, it is a subscription with paging, optimistic turns, offer
 * artifacts and a composer whose height the feed pays for. Copying that into a
 * second screen would have given the phone two conversations that drift apart
 * on exactly the parts nobody re-tests: the reset-on-switch, the echo reconcile,
 * the scroll-back page.
 *
 * So the machinery lives here and the two screens own only their own chrome.
 * Everything in this component is the transcript half of the old SessionScreen,
 * moved rather than rewritten.
 */
export function SessionConversation({
  session,
  issue,
  onOpenTerminalRef,
  findRequest = 0,
  initialPendingText,
  onInitialPendingSettled,
  deferInitialTranscript = false,
}: {
  session: SessionView
  /** The task this session belongs to; drives task context and the plan bridge. */
  issue: IssueViewModel | undefined
  /** Where a tapped `POD-…` ref in the transcript should go when it is NOT this
   *  task — absent keeps the peek sheet, which is the default everywhere. */
  onOpenTerminalRef?: (issue: IssueViewModel) => void
  /** Incremented by screen chrome to open transcript search. */
  findRequest?: number
  /** First turn supplied by the shared spawn optimism engine. */
  initialPendingText?: string
  /** Called once the transcript carries the engine-seeded first turn. */
  onInitialPendingSettled?: () => void
  /** Wait until the authority recognizes a client-minted session id. */
  deferInitialTranscript?: boolean
}) {
  const store = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      replica: s.replica,
      setSessionDraft: s.setSessionDraft,
      sendChat: s.sendChat,
      chatSendsFor: s.chatSendsFor,
      discardChat: s.discardChat,
      dismissOffer: s.dismissOffer,
      resurrectSession: s.resurrectSession,
      killSession: s.killSession,
      httpOrigin: s.httpOrigin,
    }),
    shallowEqual,
  )
  const hub = useHub()
  const issues = useIssues()
  const allSessions = useSessions()
  const machines = useMachines()
  const sessionId = session.sessionId
  const machineName = sessionValues(session).machineName
  // LIVE machine presence (this issue, POD-4830's desktop banner):
  // session.machineId -> the store's live machines list, via the same
  // live-terminal predicate (online OR daemon). Unknown (no row) reads as no
  // banner — never a fabricated offline.
  const offlineMachineName = useMemo(() => {
    const id = session.machineId
    if (!id) return null
    const machine = machines.find((m) => m.id === id)
    if (!machine || !isMachineOfflineForLiveTerminal(machine)) return null
    return machineName || 'This machine'
  }, [machines, session.machineId, machineName])
  const currentQuestion = useStoreSelector((s) =>
    (s.pendingInteractions ?? []).find(
      (row) => row.sessionId === sessionId && row.kind === 'question' && row.status === 'asked',
    ),
  )
  const storedDraft = useSessionDraft(sessionId)
  // biome-ignore lint/correctness/useExhaustiveDependencies: one seed per addressed conversation
  const draftSeed = useMemo(() => storedDraft, [sessionId])
  const trpc = store.trpc
  /**
   * THE SEND ROUTE, READ PER SEND (POD-4688). The conversation controller is
   * created once per session and owns the pending turns, so it must not be
   * rebuilt when the session's state moves — the route is a ref the deliver
   * closure reads at call time instead of a memo input.
   */
  const sendRouteRef = useRef({
    sendable: false,
    canResume: false,
    refusalReason: undefined as string | undefined,
  })
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()
  const keyboardLift = useKeyboardLift()

  const followingTranscript = useRef(true)
  const followTranscript = useCallback((following: boolean) => {
    followingTranscript.current = following
  }, [])
  const transcriptController = useMemo(
    () =>
      createTranscriptController({
        sessionId,
        initialLimit: 80,
        pageLimit: 80,
        retainHistory: () => !followingTranscript.current,
        source: {
          read: (request) => trpc.sessions.transcriptRead.query(request),
          subscribe: (sid, since, listener) => hub.subscribeTranscript(sid, since, listener),
        },
        cache: {
          read: (sid) => store.replica.transcriptWindow(sid),
          write: (sid, items) => store.replica.putTranscriptWindow(sid, [...items]),
        },
        connection: {
          connected: () => hub.connectionHealth().status !== 'down',
          subscribe: (listener) =>
            hub.onConnectionHealth((health) => listener(health.status !== 'down')),
        },
        visible: () =>
          AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
      }),
    [hub, sessionId, store.replica, trpc.sessions.transcriptRead],
  )
  const transcript = useSyncExternalStore(
    transcriptController.subscribe,
    transcriptController.getSnapshot,
  )
  const items = transcript.items
  const loaded = transcript.initialLoaded
  // The controller owns this seed after construction. The engine may retire its
  // copy when the provisional session settles, but only a transcript echo may
  // retire the pending turn shown here.
  const initialPending: ConversationPendingTurn[] = initialPendingText
    ? [
        {
          id: 'pending-first-turn',
          deliveryId: 'pending-first-turn',
          text: initialPendingText,
          wire: initialPendingText,
          at: Date.now(),
          state: 'sent',
          kind: 'message',
          // Typed at start, not sent as a message: no record follows it, and
          // the first user entry in its history is it.
          reconcile: 'next-user-item',
        },
      ]
    : []
  const storeHandle = useStoreHandle()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the spawn seed belongs to this session's controller lifetime
  const conversationController = useMemo(
    () =>
      createConversationController({
        sessionId,
        transcript: transcriptController,
        // Where each sent message stands, by id, from the synced records
        // (POD-4764) — not a poll of the ledger, and never its text.
        records: storeConversationRecords(storeHandle, sessionId),
        outbox: storeConversationOutbox(storeHandle, sessionId),
        // Its own sends the feed no longer carries — it was away while they
        // were confirmed — asked by id at start and on every reconnect (POD-4811).
        lookupRecords: (ids) =>
          trpc.messages.records.query({ ids: [...ids] }).then((answer) => answer.records),
        connection: hubConnection(hub),
        initialDraft: draftSeed,
        // The messages the outbox still holds for this session come back as the
        // bubbles they were (POD-4762): still sending — the controller waits on
        // them again — or "not sent" with their retry.
        initialPending: [
          ...initialPending,
          ...store.chatSendsFor(sessionId).map(
            (send, index): ConversationPendingTurn => ({
              id: `outbox-${index}-${send.mutationId}`,
              deliveryId: send.mutationId,
              text: send.text,
              wire: send.text,
              at: send.queuedAt,
              state: send.state,
              kind: 'message',
              ...(send.failure
                ? {
                    error: send.failure.message,
                    ...(send.failure.retryable ? {} : { retryable: false }),
                  }
                : {}),
            }),
          ),
        ],
        initialJustSent: initialPendingText !== undefined,
        onDraftChange: (text) => store.setSessionDraft(sessionId, text),
        createDeliveryId: () => `msg_${randomUUID()}`,
        deliver: async (turn) => {
          try {
            // THE ONE CHAT SEND PATH (POD-4762), messages and offer answers
            // alike: the durable outbox, keyed by the turn's own id. It
            // resolves when the server answered or the outbox gave up, so the
            // bubble reads its state from the send rather than from a timer,
            // and "Try again" re-issues the same message instead of a new one.
            // A message the outbox already holds (a reloaded conversation
            // following it, or a retry of one that gave up) is waited on or
            // re-issued as it is, whatever the route says now.
            const heldByOutbox = store
              .chatSendsFor(sessionId)
              .some((held) => held.mutationId === turn.deliveryId)
            const transport = heldByOutbox
              ? ({ kind: 'send', wake: false } as const)
              : chatSendTransport(sendRouteRef.current)
            if (transport.kind === 'refused') throw new Error(transport.reason)
            return await store.sendChat(
              { sessionId, text: turn.wire, wake: transport.wake },
              asMutationId(turn.deliveryId),
            )
          } catch (error) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {})
            throw error
          }
        },
        // The status after the request: `cancelled` when the retract won (POD-4776).
        retract: (id) =>
          trpc.messages.cancel
            .mutate({ id })
            .then(
              (message) =>
                (message as { deliveryStatus?: MessageDeliveryStatus } | null)?.deliveryStatus,
            ),
        discard: (deliveryId) => store.discardChat(asMutationId(deliveryId)),
        dismissNotice: (id) => trpc.messages.dismissNotice.mutate({ id }).then(() => {}),
        dismissOffer: (offerCreatedAt) => store.dismissOffer(sessionId, offerCreatedAt),
        // The store's recoverable outbox owns the optimistic overlay. Keeping a
        // second local hide here unmounted the action card before a rejected
        // enqueue could put its retryable error beside the dismissal control.
        optimisticDismissOffer: false,
        interrupt: (messageId) => interruptSession(trpc.sessions, sessionId, messageId),
        optimisticSendCeilingMs: OPTIMISTIC_SEND_CEILING_MS,
      }),
    [
      sessionId,
      store.dismissOffer,
      store.sendChat,
      store.chatSendsFor,
      store.discardChat,
      store.setSessionDraft,
      storeHandle,
      draftSeed,
      transcriptController,
      trpc.messages,
      trpc.sessions,
      hub,
    ],
  )
  const conversation = useSyncExternalStore(
    conversationController.subscribe,
    conversationController.getSnapshot,
  )
  const pendingTurns = useMemo<LocalPendingTurn[]>(
    () => conversation.bubbles.map(pendingTurnOf),
    [conversation.bubbles],
  )
  const justSent = conversation.justSent
  const pendingSeedSession = useRef<SessionView['sessionId'] | null>(
    initialPendingText ? sessionId : null,
  )
  const attachments = useComposerAttachments(sessionId)
  const [draftInsertion, setDraftInsertion] = useState<{ id: number; text: string } | null>(null)
  const insertionSeq = useRef(0)
  // What the feed owes the floating composer. Only ever the RESTING height, so
  // growing the field does not relayout the transcript under the operator.
  const [composerHeight, setComposerHeight] = useState(0)
  const [askHeight, setAskHeight] = useState(0)
  const [peekIssue, setPeekIssue] = useState<IssueViewModel | null>(null)
  useEffect(() => {
    if (deferInitialTranscript) return
    void transcriptController.start()
    return () => transcriptController.stop()
  }, [deferInitialTranscript, transcriptController])

  // biome-ignore lint/correctness/useExhaustiveDependencies: mark each newly rendered item batch, including an unchanged controller
  useEffect(() => {
    transcriptController.markRendered()
  }, [items, transcriptController])

  // The live stream can drop what the agent wrote; the row and a heartbeat
  // re-read it, as the desktop chat does [POD-4643].
  const activitySignal = transcriptActivitySignal(session)
  const sessionLive = session.status === 'live' || session.status === 'starting'
  useEffect(() => {
    transcriptController.observeActivity({ signal: activitySignal, live: sessionLive })
  }, [activitySignal, sessionLive, transcriptController])

  useEffect(() => {
    conversationController.start()
    return () => conversationController.stop()
  }, [conversationController])

  useEffect(() => {
    conversationController.replaceDraft(storedDraft)
  }, [conversationController, storedDraft])

  useEffect(() => {
    if (initialPendingText) pendingSeedSession.current = sessionId
    if (pendingSeedSession.current !== sessionId) return
    if (conversation.pending.some((turn) => turn.id === 'pending-first-turn')) return
    pendingSeedSession.current = null
    onInitialPendingSettled?.()
  }, [conversation.pending, initialPendingText, onInitialPendingSettled, sessionId])

  const latestOperatorPrompt = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]
      if (item?.role === 'user' && item.text.trim()) return item.text
    }
    return null
  }, [items])
  useEffect(() => {
    conversationController.updateContext({
      agentSince: session.agentState?.since,
      agentPhase: session.agentState?.phase,
      offer: session.offer,
      canInterrupt: nativeSessionCanInterrupt(session.status),
      latestOperatorPrompt,
    })
  }, [
    conversationController,
    latestOperatorPrompt,
    session.agentState,
    session.offer,
    session.status,
  ])

  /**
   * WHAT GOES ON THE WIRE IS NOT WHAT GOES IN THE BUBBLE.
   *
   * The harness reads an attachment by absolute path, so the paths are prefixed
   * onto the prompt the agent receives. The operator, who just picked a photo,
   * should see the photo — so the optimistic row keeps the prose and the paths
   * apart and renders the files the way the echoed turn will. `wire` is kept on
   * the turn so a retry re-sends the exact bytes-and-words that were refused,
   * rather than re-deriving them from a bubble that was never the message.
   */
  const send = useCallback(
    (text: string, files?: readonly SentAttachment[]) => {
      const trimmed = text.trim()
      const attached = files ?? []
      if (!trimmed && attached.length === 0) return
      const wire =
        attached.length > 0
          ? `${attached.map((file) => file.path).join('\n')}\n${trimmed}`
          : trimmed
      void conversationController.submit({
        text: trimmed,
        wire,
        ...(attached.length > 0
          ? { files: attached, toolPaths: attached.map((file) => file.path) }
          : {}),
      })
    },
    [conversationController],
  )

  const retry = useCallback(
    (turn: PendingTurn) => {
      void conversationController.retry(turn.id)
    },
    [conversationController],
  )
  // "Send again" on a message the server says did not arrive (POD-4764): its
  // words go back into the composer and the operator sends them — a NEW
  // message, by choice. Never a resend of the one that failed.
  const sendAgain = useCallback(
    (turn: PendingTurn) => {
      void conversationController.sendAgain(turn.id)
    },
    [conversationController],
  )
  const discard = useCallback(
    (turn: PendingTurn) => {
      void conversationController.discard(turn.id)
    },
    [conversationController],
  )

  const loadOlder = useCallback(() => {
    void transcriptController.loadOlder()
  }, [transcriptController])

  const transcriptStatus = transcript.offlineAsOf
    ? `Offline transcript copy · as of ${new Date(transcript.offlineAsOf).toLocaleString()}`
    : transcript.freshness === 'saved'
      ? 'Saved transcript copy'
      : transcript.freshness === 'checking'
        ? 'Checking transcript…'
        : transcript.freshness === 'rendering'
          ? 'Updating transcript…'
          : null

  // A peek stores the selected identity but renders the replica's live row, so a
  // todo toggle updates in the still-open sheet instead of waiting for reopen.
  const livePeekIssue = peekIssue
    ? (issues.find((candidate) => candidate.id === peekIssue.id) ?? peekIssue)
    : null
  /**
   * The offer this screen is still ASKING. An accept hides its card on the press
   * rather than on the round trip — the server clears the offer as part of
   * accepting it, but that clear arrives with the echo, and a card that sits
   * there through the wait reads as a press that did nothing.
   *
   * Keyed by `createdAt`, so an offer the agent REPLACES while this one is in
   * flight is a different question and shows.
   */
  // `!= null`, not `!== undefined`: a cleared offer arrives as an explicit null,
  // and reaching for `.createdAt` through it throws.
  const answered = session.offer != null && conversation.offer === null
  const offer = conversation.offer
  // THE SHARED READING OF "JUST SENT", not a local one: `chatActivity` already
  // knows that a fresh send means "Sending" on a live session and "Waking the
  // agent…" on a parked one, and the desktop chat passes the same flag into the
  // same function. This screen used to hard-code `false` here, which is why the
  // tail said Idle under a message that had visibly been sent.
  //
  // Read against the session AS ANSWERED: an accepted offer is still on the meta
  // until the server's clear lands, and `agentBadge` turns that into "waiting on
  // decision". Leaving it would put the transcript's last line back on the
  // question the operator just answered, which is the same stale claim the
  // hidden card was.
  const activity = chatActivity(answered ? withoutOffer(session) : session, justSent)
  // A newly spawned process is working before its first agent-state frame.
  const warming = session.status === 'starting' || activity?.tone === 'working'
  // A parked or ended session is present but has no process. It gets the
  // recovery banner; when there is also no conversation to show, the banner is
  // the WHOLE screen rather than a header over an empty transcript [POD-1758].
  const hasTranscript = session.transcriptAvailable ?? defaultChatCapable(session.agentKind)
  const composer = composerState({ session, headless: false, turnRunning: false, compact: false })
  sendRouteRef.current = {
    sendable: composer.sendable,
    canResume: composer.canResume,
    refusalReason: composer.refusalReason,
  }
  const readOnly = session.status === 'hibernated' || session.status === 'exited'
  /**
   * THE STOP CONTROL, ON THE DESKTOP'S TERMS [POD-4645]. Drawn while a turn is
   * running as far as this phone can tell — the agent is computing, or a send
   * has just left — and only when a stop may be attempted at all. The press is
   * the shared controller's `interrupt`, the same call the desktop composer's
   * Stop makes: it puts the last prompt back in an empty draft and sends
   * `sessions.interrupt` with the queued message it selected, so whatever the
   * server does per harness to end the turn, the phone gets too.
   */
  const turnActive = isAgentComputing(session) || justSent
  const stopTurn =
    turnActive && conversation.canInterrupt
      ? () => void conversationController.interrupt(conversation.draft)
      : undefined
  // "Not stopped", not "Not sent": what failed is that the agent is STILL
  // running, and the phone has no other place that would say so.
  const composerCaption = conversation.interruptError
    ? `Not stopped: ${conversation.interruptError}`
    : transcriptStatus
  // A question Claude Code has not written into its transcript yet: the hook
  // channel carries it from the moment the dialog opens, the transcript only
  // once the call resolves (POD-1273). The transcript stays the better source
  // the instant it has one, so this is consulted only while it has none.
  const need = session.agentState?.need
  const phase = session.agentState?.phase
  const pendingAsk = useMemo(
    () =>
      pendingAskFromState(need, session.status, phase, latestPendingQuestion(items) !== null)
        ?.item ?? null,
    [items, need, phase, session.status],
  )
  const pendingQuestion = useMemo(
    () => latestPendingQuestion(items) ?? pendingAsk,
    [items, pendingAsk],
  )
  const askAnswerable =
    pendingAsk !== null ||
    session.status === 'live' ||
    session.status === 'starting' ||
    session.status === 'reconnecting'
  const pendingAskedAt = pendingQuestion?.ts ?? session.agentState?.since
  useEffect(() => {
    if (!pendingQuestion) setAskHeight(0)
  }, [pendingQuestion])

  const answerAsk = useCallback(
    async (answer: AskQuestionAnswer) => {
      if (
        currentQuestion &&
        (answer.interactionId !== currentQuestion.id ||
          !answer.question ||
          !matchesQuestionInteraction(currentQuestion, answer.question))
      ) {
        throw new Error('The question changed; wait for the current menu.')
      }
      const sent = await trpc.sessions.answerAskUserQuestion.mutate({
        sessionId,
        interactionId: answer.interactionId,
        ...answer,
      })
      if (sent?.ok === false) throw new Error(sent.reason ?? 'answer not delivered')
    },
    [sessionId, currentQuestion, trpc.sessions.answerAskUserQuestion],
  )

  /**
   * ACCEPTING AN OFFER IS SENDING A MESSAGE, and it now looks like one.
   *
   * It used to be the only send on this screen with no optimistic half: the
   * button called straight through to the wire, so between the press and the
   * server's echo the transcript showed nothing at all — no bubble, no working
   * state, and the offer still sitting there. On a parked session, which is
   * exactly the session an offer is usually posted from, that gap is minutes.
   *
   * The three optimistic parts, all of which the desktop already had: the offer
   * leaves, the prompt appears as a pending "You" row, and the tail says
   * working. A refusal puts all three back — the offer returns, the row goes red
   * with the reason and a Try again, and the caller sees the throw so the card
   * can say "Not sent" too.
   */
  const acceptOffer = (prompt: string, offerCreatedAt: string): Promise<void> =>
    conversationController.sendOffer(prompt, offerCreatedAt).then(() => {})

  return (
    <View style={styles.flex}>
      <MobileSessionLifecycle
        session={session}
        hasTranscript={hasTranscript}
        onResume={store.resurrectSession}
        onRemove={store.killSession}
      />
      {offlineMachineName ? (
        <View
          style={styles.offlineBanner}
          testID="machine-offline-banner"
          accessibilityRole="alert"
        >
          <Text style={styles.offlineText}>
            {`machine '${offlineMachineName}' is offline — showing last known transcript.`}
          </Text>
        </View>
      ) : null}
      {readOnly && !hasTranscript ? null : (
        <BootstrapCrossfade
          resolved={loaded || items.length > 0}
          placeholder={<TranscriptSkeleton />}
        >
          <PullToRefreshBoundary
            connected={connected}
            refreshing={refreshing}
            onRefresh={onRefresh}
          >
            <TranscriptList
              items={items}
              live={session.status === 'live'}
              assetContext={{ httpOrigin: store.httpOrigin, sessionId, cwd: session.cwd }}
              pendingTurns={pendingTurns}
              hidePendingQuestion
              findRequest={findRequest}
              onRetryPending={retry}
              onDiscardPending={discard}
              onSendAgainPending={sendAgain}
              onRetractPending={(id) => void conversationController.retract(id)}
              onQuote={(text) => setDraftInsertion({ id: insertionSeq.current++, text })}
              bottomInset={composerHeight + askHeight + keyboardLift}
              streaming={
                activity?.tone === 'working' &&
                items.at(-1)?.role === 'assistant' &&
                items.at(-1)?.answer !== true
              }
              tail={{
                label:
                  activity?.label ??
                  (session.agentState?.phase === 'idle' ? 'Idle' : session.status),
                tone: activity?.tone === 'attention' ? 'attention' : activity ? 'working' : 'idle',
                since: session.agentState?.since,
              }}
              refreshControl={refreshControl}
              refreshAccessibilityProps={refreshAccessibilityProps}
              emptyComponent={
                // An offer is itself the thing to act on — do not tell the
                // operator the session is empty underneath a pending decision.
                loaded &&
                items.length === 0 &&
                pendingTurns.length === 0 &&
                !offer &&
                !pendingQuestion ? (
                  <EmptyTranscript warming={warming} />
                ) : undefined
              }
              onAnswer={answerAsk}
              answerInteractionId={currentQuestion?.id}
              onLoadOlder={loadOlder}
              moreAbove={transcript.hasMoreOlder}
              loadingOlder={transcript.loadingOlder}
              onFollowChange={followTranscript}
              onRefPress={(ref) => {
                const seq = Number(ref.slice(4))
                const target = issues.find((i) => i.seq === seq)
                if (!target) return
                if (onOpenTerminalRef) onOpenTerminalRef(target)
                else setPeekIssue(target)
              }}
              footer={
                offer ? (
                  <SessionActionCard
                    offer={offer}
                    issue={issue}
                    {...(session.lastInputAt ? { lastInputAt: session.lastInputAt } : {})}
                    onAction={(prompt) => acceptOffer(prompt, offer.createdAt)}
                    // The same write the web x makes: the offer leaves every
                    // surface and every viewer, not just this phone.
                    onDismiss={(offerCreatedAt) =>
                      conversationController.dismissOffer(offerCreatedAt)
                    }
                    onOpenEvidence={issue ? () => setPeekIssue(issue) : undefined}
                  />
                ) : undefined
              }
            />
          </PullToRefreshBoundary>
        </BootstrapCrossfade>
      )}
      {/* The composer floats OVER the feed rather than ending it [POD-502]. The
          feed pays for it with the composer's own resting height. */}
      {readOnly && !hasTranscript ? null : (
        <View style={[styles.composerLayer, { bottom: keyboardLift }]} pointerEvents="box-none">
          {/* THE BLOCKED-SESSION BAND (POD-2414) — above the ask card, because
              the kinds it renders are the ones nothing else on this screen can
              show, and a session blocked on one of them has nothing else to
              read. It draws only while an ask is open. */}
          <PendingInteractionBand sessionId={sessionId} />
          {pendingQuestion ? (
            <View
              onLayout={(event) => setAskHeight(event.nativeEvent.layout.height)}
              style={styles.askLayer}
            >
              <AskQuestionCard
                key={currentQuestion?.id}
                interactionId={currentQuestion?.id}
                item={pendingQuestion}
                live={askAnswerable}
                onAnswer={answerAsk}
                presentation="band"
                {...(pendingAskedAt ? { askedAt: pendingAskedAt } : {})}
              />
            </View>
          ) : null}
          <Composer
            placeholder={composer.placeholder}
            onSend={send}
            value={conversation.draft}
            onChangeText={conversationController.setDraft.bind(conversationController)}
            caption={composerCaption}
            captionTone={conversation.interruptError ? 'attention' : 'working'}
            sendDisabled={!composer.deliverable}
            draftInsertion={draftInsertion}
            attachments={attachments}
            onRestingHeight={setComposerHeight}
            onStop={stopTurn}
          />
        </View>
      )}
      <TaskSheet
        issue={livePeekIssue}
        issues={issues}
        sessions={allSessions}
        onClose={() => setPeekIssue(null)}
        onOpenSession={() => setPeekIssue(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  /**
   * THE OFFLINE-MACHINE BANNER (this issue) — the phone's copy of the
   * desktop's `transcript-offline-banner` (POD-4830): the same
   * "machine '<name>' is offline — showing last known transcript" copy from
   * the same live-terminal predicate and the same live presence, cleared on
   * reattach. Danger tone, bar chrome like the lifecycle banner above it.
   */
  offlineBanner: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.dangerSoft,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.danger,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 1,
  },
  offlineText: {
    ...sans(500),
    flex: 1,
    color: color.dangerText,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
  /** Lifted by the measured keyboard overlap without resizing the feed. */
  composerLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  askLayer: {
    backgroundColor: color.engraved,
  },
  /** Claims the feed remainder so the floating composer stays anchored. */
  empty: {
    flex: 1,
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.xxl,
    paddingVertical: space.xxl,
  },
  /** Fixed for both moods, so changing the mark does not move the copy. */
  emptyMark: {
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  emptyTitle: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.small,
  },
  emptyBody: {
    ...sans(400),
    maxWidth: 260,
    color: color.textFaint,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
    textAlign: 'center',
  },
})
