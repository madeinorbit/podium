import { sessionPaneView } from '@podium/client-graph/session-pane'
import {
  type Conversation,
  PHONE_WARM_CONVERSATIONS,
  type ConversationPendingTurn,
  hubConnection,
} from '@podium/client-core/conversation'
import { randomUUID } from '@podium/client-core/id'
import { useConversation, useStoreHandle } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  chatActivity,
  composerState,
  defaultChatCapable,
  matchesQuestionInteraction,
  OPTIMISTIC_SEND_CEILING_MS,
  pendingAskFromState,
} from '@podium/client-core/values'
import {
  asMutationId,
  isAgentComputing,
  isMachineOfflineForLiveTerminal,
  type MessageDeliveryStatus,
} from '@podium/model'
import * as Haptics from 'expo-haptics'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { action, observable, reaction, when } from 'mobx'
import { observer } from 'mobx-react-lite'
import { useMobilePool } from '../client/mobile-pool'
import { AppState, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import type { MobileTrpc } from '../client/trpc'
import {
  useSessionContextIssues as useIssues,
  useSessionContextIssue,
  useSessionContextMachine,
  useSessionContextMachineHome,
  useSessionContextQuestion,
  useSessionContextReferenceIssue,
  useSessionConversationPorts,
  mobileConversationPorts,
  useSessionContextSessions as useSessions,
} from '../client/use-session-context'
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

const SessionComposer = observer(function SessionComposer({
  conversation,
  placeholder,
  onSend,
  caption,
  captionTone,
  sendDisabled,
  draftInsertion,
  attachments,
  onRestingHeight,
  turnActive,
  canInterrupt,
}: {
  conversation: Conversation
  placeholder: string
  onSend: (text: string, files?: readonly SentAttachment[]) => void
  caption?: string | null
  captionTone?: 'working' | 'attention'
  sendDisabled?: boolean
  draftInsertion?: { id: number; text: string } | null
  attachments?: ReturnType<typeof useComposerAttachments>
  onRestingHeight?: (height: number) => void
  turnActive: boolean
  canInterrupt: boolean
}) {
  const draft = conversation.draft
  const setDraft = useCallback(
    (text: string) => {
      conversation.draft = text
    },
    [conversation],
  )
  const handleStop = useCallback(() => {
    void conversation.sends.interrupt(conversation.draft)
  }, [conversation])
  const onStop = turnActive && canInterrupt ? handleStop : undefined
  return (
    <Composer
      placeholder={placeholder}
      onSend={onSend}
      value={draft}
      onChangeText={setDraft}
      caption={caption}
      captionTone={captionTone}
      sendDisabled={sendDisabled}
      draftInsertion={draftInsertion}
      attachments={attachments}
      onRestingHeight={onRestingHeight}
      onStop={onStop}
    />
  )
})

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
export function SessionConversation(
  props: Omit<Parameters<typeof SessionConversationBody>[0], 'model' | 'history'>,
) {
  const owner = useStoreHandle<MobileTrpc>()
  const pool = useMobilePool()
  const sessionId = props.session.sessionId
  const readiness = useSessionConversationPorts(sessionId)
  const ports = useMemo(
    () => (pool ? mobileConversationPorts(pool, sessionId) : readiness),
    [pool, sessionId],
  )
  const history = useRef({ following: true, searching: false })
  const recognized = useMemo(() => observable.box(!props.deferInitialTranscript), [sessionId])
  useLayoutEffect(
    () => action(() => recognized.set(!props.deferInitialTranscript))(),
    [recognized, props.deferInitialTranscript],
  )
  const model = useConversation(
    sessionId,
    (drafts) => ({
      sessionId,
      drafts,
      readSession: () => (pool ? sessionPaneView(pool).session(sessionId) : undefined),
      hub: owner.hub,
      connection: hubConnection(owner.hub),
      scheduler: {
        visible: () =>
          AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
        onVisibilityChange: (listener) => {
          const subscription = AppState.addEventListener('change', listener)
          return () => subscription.remove()
        },
      },
      transcript: {
        retainHistory: () => !history.current.following || history.current.searching,
        initialLimit: 80,
        pageLimit: 80,
        source: {
          read: (request) =>
            when(() => recognized.get()).then(() =>
              owner.access.trpc.sessions.transcriptRead.query(request),
            ),
          subscribe: (id, since, listener) => {
            let off = () => {}
            const stop = reaction(
              () => recognized.get(),
              (ready) => {
                off()
                off = ready ? owner.hub.subscribeTranscript(id, since, listener) : () => {}
              },
              { fireImmediately: true },
            )
            return () => {
              stop()
              off()
            }
          },
        },
        cache: {
          read: (id) => owner.replica.transcriptWindow(id),
          write: (id, items) => owner.replica.putTranscriptWindow(id, [...items]),
        },
      },
      sends: {
        records: ports.records,
        outbox: ports.outbox,
        initialPending: [
          ...(props.initialPendingText
            ? [
                {
                  id: 'pending-first-turn',
                  deliveryId: 'pending-first-turn',
                  text: props.initialPendingText,
                  wire: props.initialPendingText,
                  at: Date.now(),
                  state: 'sent' as const,
                  kind: 'message' as const,
                  reconcile: 'next-user-item' as const,
                },
              ]
            : []),
          ...ports.outbox
            .held()
            .map(
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
        initialJustSent: props.initialPendingText !== undefined,
        createDeliveryId: () => `msg_${randomUUID()}`,
        lookupRecords: (ids) =>
          owner.access.trpc.messages.records
            .query({ ids: [...ids] })
            .then((answer) => answer.records),
        deliver: async (turn) => {
          try {
            const session = (pool ? sessionPaneView(pool).session(sessionId) : undefined)
            const composer = composerState({
              session: session ?? props.session,
              headless: false,
              turnRunning: false,
              compact: false,
            })
            const held = ports.outbox.held().some((send) => send.mutationId === turn.deliveryId)
            const transport = held
              ? { kind: 'send' as const, wake: false }
              : chatSendTransport(composer)
            if (transport.kind === 'refused') throw new Error(transport.reason)
            return await owner.access.sendChat(
              { sessionId, text: turn.wire, wake: transport.wake },
              asMutationId(turn.deliveryId),
            )
          } catch (error) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {})
            throw error
          }
        },
        retract: (id) =>
          owner.access.trpc.messages.cancel
            .mutate({ id })
            .then(
              (message) =>
                (message as { deliveryStatus?: MessageDeliveryStatus } | null)?.deliveryStatus,
            ),
        discard: (id) => owner.access.discardChat(asMutationId(id)),
        dismissNotice: (id) =>
          owner.access.trpc.messages.dismissNotice.mutate({ id }).then(() => {}),
        dismissOffer: (at) => owner.access.dismissOffer(sessionId, at),
        optimisticDismissOffer: false,
        interrupt: (id) => interruptSession(owner.access.trpc.sessions, sessionId, id),
        optimisticSendCeilingMs: OPTIMISTIC_SEND_CEILING_MS,
      },
    }),
    { warmLimit: PHONE_WARM_CONVERSATIONS, enabled: pool !== null && readiness.ready },
  )
  return model ? (
    <SessionConversationBody {...props} model={model} history={history.current} />
  ) : (
    <TranscriptSkeleton />
  )
}

const SessionConversationBody = observer(function SessionConversationBody({
  session,
  model,
  history,
  issue,
  onOpenTerminalRef,
  findRequest = 0,
  initialPendingText,
  onInitialPendingSettled,
}: {
  session: SessionView
  model: Conversation
  history: { following: boolean; searching: boolean }
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
  const storeHandle = useStoreHandle<MobileTrpc>()
  const store = useMemo(() => {
    const s = storeHandle.access
    return {
      trpc: s.trpc,
      replica: s.replica,
      sendChat: s.sendChat,
      discardChat: s.discardChat,
      dismissOffer: s.dismissOffer,
      resurrectSession: s.resurrectSession,
      killSession: s.killSession,
      httpOrigin: s.httpOrigin,
    }
  }, [storeHandle])
  const [peekIssue, setPeekIssue] = useState<IssueViewModel | null>(null)
  const [requestedRef, setRequestedRef] = useState<string | undefined>(undefined)
  // Catalogs belong to the open inspector, not conversation startup.
  const issues = useIssues(peekIssue !== null)
  const allSessions = useSessions(peekIssue !== null)
  const referencedIssue = useSessionContextReferenceIssue(requestedRef)
  useEffect(() => {
    if (requestedRef === undefined || referencedIssue === undefined) return
    setRequestedRef(undefined)
    if (referencedIssue === null) return
    if (onOpenTerminalRef) onOpenTerminalRef(referencedIssue)
    else setPeekIssue(referencedIssue)
  }, [requestedRef, referencedIssue, onOpenTerminalRef])
  const machine = useSessionContextMachine(session.machineId)
  const sessionId = session.sessionId
  const homeName = useSessionContextMachineHome(session.machineId)
  // Offline predicate on LIVE presence, display name on the REPLICATED home
  // (POD-5661; POD-4830's desktop banner reads the same server truth from its
  // transcript page): session.machineId -> the live machine row for the
  // live-terminal predicate (online OR daemon), and -> the feed's machine
  // home for the name. The live row's label and the session row's stale label
  // never name the banner; an absent or empty home reads 'This machine'.
  // Unknown (no live row) reads as no banner — never a fabricated offline.
  const offlineMachineName = useMemo(() => {
    if (!machine || !isMachineOfflineForLiveTerminal(machine)) return null
    return homeName || 'This machine'
  }, [machine, homeName])
  const currentQuestion = useSessionContextQuestion(sessionId)
  const trpc = store.trpc
  /**
   * THE SEND ROUTE, READ PER SEND (POD-4688). The Conversation is
   * created once per session and owns the pending turns, so it must not be
   * rebuilt when the session's state moves — the route is a ref the deliver
   * closure reads at call time instead of a memo input.
   */
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()
  const keyboardLift = useKeyboardLift()

  const followTranscript = useCallback(
    (following: boolean) => (history.following = following),
    [history],
  )
  const searchTranscript = useCallback(
    (searching: boolean) => (history.searching = searching),
    [history],
  )
  const transcript = model.transcript
  const conversation = model.sends
  const loaded = transcript.initialLoaded
  const itemCount = transcript.ids.length
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
  useEffect(() => {
    transcript.markRendered()
  }, [itemCount, transcript])
  const pendingSeed = conversation.pending.some((turn) => turn.id === 'pending-first-turn')
  useEffect(() => {
    if (initialPendingText) pendingSeedSession.current = sessionId
    if (pendingSeedSession.current !== sessionId) return
    if (pendingSeed) return
    pendingSeedSession.current = null
    onInitialPendingSettled?.()
  }, [pendingSeed, initialPendingText, onInitialPendingSettled, sessionId])

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
      void conversation.submit({
        text: trimmed,
        wire,
        ...(attached.length > 0
          ? { files: attached, toolPaths: attached.map((file) => file.path) }
          : {}),
      })
    },
    [conversation],
  )

  const retry = useCallback(
    (turn: PendingTurn) => {
      void conversation.retry(turn.id)
    },
    [conversation],
  )
  // "Send again" on a message the server says did not arrive (POD-4764): its
  // words go back into the composer and the operator sends them — a NEW
  // message, by choice. Never a resend of the one that failed.
  const sendAgain = useCallback(
    (turn: PendingTurn) => {
      void conversation.sendAgain(turn.id)
    },
    [conversation],
  )
  const discard = useCallback(
    (turn: PendingTurn) => {
      void conversation.discard(turn.id)
    },
    [conversation],
  )

  const loadOlder = useCallback(() => {
    void transcript.loadOlder()
  }, [transcript])

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
  const addressedPeekIssue = useSessionContextIssue(peekIssue?.id)
  const livePeekIssue = peekIssue ? (addressedPeekIssue ?? peekIssue) : null
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
  const readOnly = session.status === 'hibernated' || session.status === 'exited'
  /**
   * THE STOP CONTROL, ON THE DESKTOP'S TERMS [POD-4645]. Drawn while a turn is
   * running as far as this phone can tell — the agent is computing, or a send
   * has just left — and only when a stop may be attempted at all. The press is
   * the shared Sends model's `interrupt`, the same call the desktop composer's
   * Stop makes: it puts the last prompt back in an empty draft and sends
   * `sessions.interrupt` with the queued message it selected, so whatever the
   * server does per harness to end the turn, the phone gets too.
   *
   * The draft is read at press time inside the composer leaf, so this flag and
   * the interrupt capability stay stable across keystrokes (this issue).
   */
  const turnActive = isAgentComputing(session) || justSent
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
  const transcriptQuestion = transcript.pendingQuestion
  const pendingAsk = useMemo(
    () =>
      pendingAskFromState(need, session.status, phase, transcriptQuestion !== null)?.item ?? null,
    [transcriptQuestion, need, phase, session.status],
  )
  const pendingQuestion = transcriptQuestion ?? pendingAsk
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
  const acceptOffer = useCallback(
    (prompt: string, offerCreatedAt: string): Promise<void> =>
      conversation.sendOffer(prompt, offerCreatedAt).then(() => {}),
    [conversation],
  )
  const retractPending = useCallback((id: string) => void conversation.retract(id), [conversation])
  const quoteIntoDraft = useCallback((text: string) => {
    setDraftInsertion({ id: insertionSeq.current++, text })
  }, [])
  const dismissOfferRow = useCallback(
    (offerCreatedAt: string) => conversation.dismissOffer(offerCreatedAt),
    [conversation],
  )
  const openOfferEvidence = useCallback(() => {
    if (issue) setPeekIssue(issue)
  }, [issue])
  const assetContext = useMemo(
    () => ({ httpOrigin: store.httpOrigin, sessionId, cwd: session.cwd }),
    [store.httpOrigin, sessionId, session.cwd],
  )
  const tailState = useMemo(
    () => ({
      label: activity?.label ?? (session.agentState?.phase === 'idle' ? 'Idle' : session.status),
      tone: (activity?.tone === 'attention' ? 'attention' : activity ? 'working' : 'idle') as
        | 'working'
        | 'attention'
        | 'idle',
      since: session.agentState?.since,
    }),
    [activity, session.agentState?.phase, session.agentState?.since, session.status],
  )
  const streamingActive = activity?.tone === 'working'
  const emptyState = useMemo(
    () =>
      loaded && itemCount === 0 && pendingTurns.length === 0 && !offer && !pendingQuestion ? (
        <EmptyTranscript warming={warming} />
      ) : undefined,
    [loaded, itemCount, pendingTurns.length, offer, pendingQuestion, warming],
  )
  const footerNode = useMemo(
    () =>
      offer ? (
        <SessionActionCard
          offer={offer}
          issue={issue}
          {...(session.lastInputAt ? { lastInputAt: session.lastInputAt } : {})}
          onAction={(prompt) => acceptOffer(prompt, offer.createdAt)}
          // The same write the web x makes: the offer leaves every
          // surface and every viewer, not just this phone.
          onDismiss={dismissOfferRow}
          onOpenEvidence={issue ? openOfferEvidence : undefined}
        />
      ) : undefined,
    [offer, issue, session.lastInputAt, acceptOffer, dismissOfferRow, openOfferEvidence],
  )
  const captionTone = conversation.interruptError ? 'attention' : 'working'

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
        <BootstrapCrossfade resolved={loaded || itemCount > 0} placeholder={<TranscriptSkeleton />}>
          <PullToRefreshBoundary
            connected={connected}
            refreshing={refreshing}
            onRefresh={onRefresh}
          >
            <TranscriptList
              transcript={transcript}
              transcriptQuestion={transcriptQuestion}
              live={session.status === 'live'}
              assetContext={assetContext}
              pendingTurns={pendingTurns}
              hidePendingQuestion
              findRequest={findRequest}
              onRetryPending={retry}
              onDiscardPending={discard}
              onSendAgainPending={sendAgain}
              onRetractPending={retractPending}
              onQuote={quoteIntoDraft}
              bottomInset={composerHeight + askHeight + keyboardLift}
              streaming={streamingActive}
              tail={tailState}
              refreshControl={refreshControl}
              refreshAccessibilityProps={refreshAccessibilityProps}
              emptyComponent={emptyState}
              onAnswer={answerAsk}
              answerInteractionId={currentQuestion?.id}
              onLoadOlder={loadOlder}
              moreAbove={transcript.hasMoreOlder}
              loadingOlder={transcript.loadingOlder}
              onFollowChange={followTranscript}
              onSearchChange={searchTranscript}
              onRefPress={setRequestedRef}
              footer={footerNode}
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
          <SessionComposer
            conversation={model}
            placeholder={composer.placeholder}
            onSend={send}
            caption={composerCaption}
            captionTone={captionTone}
            sendDisabled={!composer.deliverable}
            draftInsertion={draftInsertion}
            attachments={attachments}
            onRestingHeight={setComposerHeight}
            turnActive={turnActive}
            canInterrupt={conversation.canInterrupt}
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
})

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
