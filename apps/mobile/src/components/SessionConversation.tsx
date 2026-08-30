import {
  chatActivity,
  composerState,
  defaultChatCapable,
  latestPendingQuestion,
  OPTIMISTIC_SEND_CEILING_MS,
  pendingAskFromState,
} from '@podium/client-core/viewmodels'
import {
  createConversationController,
  nativeSessionCanInterrupt,
} from '@podium/client-core/conversation'
import { randomUUID } from '@podium/client-core/id'
import { createTranscriptController } from '@podium/client-core/transcript'
import { asMutationId, type IssueWire, type SessionMeta } from '@podium/model'
import * as Haptics from 'expo-haptics'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  useHub,
  useIssues,
  useMobileStore,
  useSessionDraft,
  useSessions,
} from '../client/hooks'
import { useKeyboardLift } from '../hooks/useKeyboardHeight'
import { useRefreshableList } from '../hooks/useRefreshableTab'
import { sendOfferAction } from '../lib/send-offer-action'
import { color } from '../theme/theme'
import { type AskQuestionAnswer, AskQuestionCard } from './AskQuestionCard'
import { Composer } from './Composer'
import { BootstrapCrossfade, TranscriptSkeleton } from './LaunchPlaceholders'
import { PullToRefreshBoundary } from './PullToRefreshBoundary'
import { SessionActionCard } from './SessionActionCard'
import { MobileSessionLifecycle } from './SessionLifecycle'
import { TaskSheet } from './TaskSheet'
import { type PendingTurn, TranscriptList } from './TranscriptList'
import { EmptyState } from './ui'
import { type SentAttachment, useComposerAttachments } from './useComposerAttachments'

/**
 * A pending turn plus the exact string that was put on the wire.
 *
 * Not part of {@link PendingTurn} because the transcript has no use for it: the
 * list renders prose and files, and the composed prompt is an implementation
 * detail of sending. Keeping it here means a retry re-sends what was refused
 * instead of reconstructing it.
 */
type LocalPendingTurn = PendingTurn & { wire: string }

/** The session as the operator has just left it — the answered offer removed,
 *  so every derivation over it agrees with what is on screen. */
function withoutOffer(session: SessionMeta): SessionMeta {
  const { offer: _answered, ...rest } = session
  return rest as SessionMeta
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
}: {
  session: SessionMeta
  /** The task this session belongs to; drives task context and the plan bridge. */
  issue: IssueWire | undefined
  /** Where a tapped `POD-…` ref in the transcript should go when it is NOT this
   *  task — absent keeps the peek sheet, which is the default everywhere. */
  onOpenTerminalRef?: (issue: IssueWire) => void
  /** Incremented by screen chrome to open transcript search. */
  findRequest?: number
}) {
  const store = useMobileStore()
  const hub = useHub()
  const issues = useIssues()
  const allSessions = useSessions()
  const sessionId = session.sessionId
  const storedDraft = useSessionDraft(sessionId)
  // biome-ignore lint/correctness/useExhaustiveDependencies: one seed per addressed conversation
  const draftSeed = useMemo(() => storedDraft, [sessionId])
  const trpc = store.trpc
  const sessionStatusRef = useRef(session.status)
  sessionStatusRef.current = session.status
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()
  const keyboardLift = useKeyboardLift()

  const transcriptController = useMemo(
    () =>
      createTranscriptController({
        sessionId,
        initialLimit: 80,
        pageLimit: 80,
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
      }),
    [hub, sessionId, store.replica, trpc.sessions.transcriptRead],
  )
  const transcript = useSyncExternalStore(
    transcriptController.subscribe,
    transcriptController.getSnapshot,
  )
  const items = transcript.items
  const loaded = transcript.initialLoaded
  const conversationController = useMemo(
    () =>
      createConversationController({
        sessionId,
        transcript: transcriptController,
        initialDraft: draftSeed,
        onDraftChange: (text) => store.setSessionDraft(sessionId, text),
        createDeliveryId: () => `msg_${randomUUID()}`,
        deliver: async (turn) => {
          try {
            if (turn.kind === 'offer') {
              await sendOfferAction(trpc.sessions, {
                sessionId,
                text: turn.wire,
                wake: sessionStatusRef.current !== 'live',
                mutationId: asMutationId(turn.deliveryId),
              })
            } else {
              await store.resumeAndSend(sessionId, turn.wire, asMutationId(turn.deliveryId))
            }
            return { state: 'queued' }
          } catch (error) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {})
            throw error
          }
        },
        readQueue: () => trpc.messages.ledger.query({ sessionId, limit: 100 }),
        retract: (id) => trpc.messages.cancel.mutate({ id }).then(() => {}),
        dismissOffer: (offerCreatedAt) => store.dismissOffer(sessionId, offerCreatedAt),
        interrupt: async (messageId) => {
          const result = await trpc.sessions.interrupt.mutate({
            sessionId,
            ...(messageId ? { messageId } : {}),
          })
          if (result?.ok === false)
            throw new Error(result.reason ?? 'the agent refused the interrupt')
        },
        optimisticSendCeilingMs: OPTIMISTIC_SEND_CEILING_MS,
      }),
    [
      sessionId,
      store.dismissOffer,
      store.resumeAndSend,
      store.setSessionDraft,
      draftSeed,
      transcriptController,
      trpc.messages,
      trpc.sessions,
    ],
  )
  const conversation = useSyncExternalStore(
    conversationController.subscribe,
    conversationController.getSnapshot,
  )
  const pendingTurns = useMemo<LocalPendingTurn[]>(() => {
    const projected = conversation.projected.pending.map((turn) => ({
      at: turn.at,
      value: {
        id: turn.id,
        text: turn.text,
        wire: turn.wire,
        ...(turn.files ? { files: turn.files as readonly SentAttachment[] } : {}),
        ...(turn.error ? { failed: turn.error } : {}),
        ...(turn.state === 'interrupted' ? { interrupted: true } : {}),
        ...(turn.durable?.injectedAt === null ? { queuedId: turn.durable.id } : {}),
        ...(turn.state === 'queued' || turn.durable ? { queued: true } : {}),
      } satisfies LocalPendingTurn,
    }))
    const restored = conversation.projected.queued.map((message) => ({
      at: message.at,
      value: {
        id: `queued:${message.id}`,
        text: message.text,
        wire: message.text,
        ...(message.injectedAt === null ? { queuedId: message.id } : {}),
        queued: true,
      } satisfies LocalPendingTurn,
    }))
    return [...projected, ...restored]
      .sort((left, right) => left.at - right.at || left.value.id.localeCompare(right.value.id))
      .map((entry) => entry.value)
  }, [conversation.projected])
  const justSent = conversation.justSent
  const attachments = useComposerAttachments(sessionId)
  const [draftInsertion, setDraftInsertion] = useState<{ id: number; text: string } | null>(null)
  const insertionSeq = useRef(0)
  // What the feed owes the floating composer. Only ever the RESTING height, so
  // growing the field does not relayout the transcript under the operator.
  const [composerHeight, setComposerHeight] = useState(0)
  const [askHeight, setAskHeight] = useState(0)
  const [peekIssue, setPeekIssue] = useState<IssueWire | null>(null)
  useEffect(() => {
    void transcriptController.start()
    return () => transcriptController.dispose()
  }, [transcriptController])

  useEffect(() => {
    transcriptController.markRendered()
  }, [items, transcriptController])

  useEffect(() => {
    void conversationController.start()
    return () => conversationController.dispose()
  }, [conversationController])

  useEffect(() => {
    conversationController.replaceDraft(storedDraft)
  }, [conversationController, storedDraft])

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
  // A parked or ended session is present but has no process. It gets the
  // recovery banner; when there is also no conversation to show, the banner is
  // the WHOLE screen rather than a header over an empty transcript [POD-1758].
  const hasTranscript = session.transcriptAvailable ?? defaultChatCapable(session.agentKind)
  const composer = composerState({ session, headless: false, turnRunning: false, compact: false })
  const readOnly = session.status === 'hibernated' || session.status === 'exited'
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
      const sent = await trpc.sessions.answerAskUserQuestion.mutate({
        sessionId,
        ...answer,
      })
      if (sent?.ok === false) throw new Error(sent.reason ?? 'answer not delivered')
    },
    [sessionId, trpc.sessions.answerAskUserQuestion],
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
                  <EmptyState
                    fill
                    title="No transcript yet"
                    body="Send a message to get things moving."
                  />
                ) : undefined
              }
              onAnswer={answerAsk}
              onLoadOlder={loadOlder}
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
          {pendingQuestion ? (
            <View
              onLayout={(event) => setAskHeight(event.nativeEvent.layout.height)}
              style={styles.askLayer}
            >
              <AskQuestionCard
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
            caption={transcriptStatus}
            disabled={!composer.enabled}
            draftInsertion={draftInsertion}
            attachments={attachments}
            onRestingHeight={setComposerHeight}
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
})
