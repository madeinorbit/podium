import {
  chatActivity,
  composerState,
  defaultChatCapable,
  latestPendingQuestion,
  mergeTranscriptItems,
  pendingAskFromState,
  prependTranscriptItems,
} from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta, TranscriptItem } from '@podium/model'
import * as Haptics from 'expo-haptics'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native'
import { readTranscriptPage, useHub, useIssues, useMobileStore, useSessions } from '../client/hooks'
import { useRefreshableList } from '../hooks/useRefreshableTab'
import { resolveOfferArtifacts } from '../lib/offer-artifacts'
import { dropEchoedPendingTurns } from '../lib/pending-turns'
import { sendOfferAction } from '../lib/send-offer-action'
import { color } from '../theme/theme'
import { AskQuestionCard, type AskQuestionAnswer } from './AskQuestionCard'
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
  const trpc = store.trpc
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()

  const [items, setItems] = useState<TranscriptItem[]>(
    () => store.replica.transcriptWindow(sessionId)?.items ?? [],
  )
  const [loaded, setLoaded] = useState(false)
  // Turns sent from this screen, painted until the server echoes them into the
  // transcript (POD-338). A parked session queues the message and answers
  // minutes later — without this the composer reads as if it never sent.
  const [pendingTurns, setPendingTurns] = useState<LocalPendingTurn[]>([])
  const turnSeq = useRef(0)
  /**
   * True for a beat after ANY send from this screen — composer or offer button.
   *
   * The transcript's tail reads the session's own agent state, which is a
   * server fact and arrives after the round trip. Between the press and that
   * frame the session still says "Idle" under a message that has visibly been
   * sent, so the app reads as having swallowed it. The desktop chat carries the
   * same flag for the same reason (`justSent` in `use-chat-send.ts`); it is a
   * claim about THIS client's action, not about the agent, and it expires on
   * its own so a refused send cannot leave a permanent "working".
   */
  const [justSent, setJustSent] = useState(false)
  /**
   * The offer hidden by an accept that has not been echoed yet, keyed by its
   * createdAt. The server clears the offer as part of accepting it, but that
   * clear rides the same round trip as the send — leaving the card on screen
   * until it lands makes the press look ignored, and invites a second press on
   * a decision already taken. Cleared again if the send is REFUSED, because
   * then the offer really is still open.
   */
  const [answeredOfferAt, setAnsweredOfferAt] = useState<string | null>(null)
  const attachments = useComposerAttachments(sessionId)
  const [draftInsertion, setDraftInsertion] = useState<{ id: number; text: string } | null>(null)
  const insertionSeq = useRef(0)
  // What the feed owes the floating composer. Only ever the RESTING height, so
  // growing the field does not relayout the transcript under the operator.
  const [composerHeight, setComposerHeight] = useState(0)
  const [askHeight, setAskHeight] = useState(0)
  const [peekIssue, setPeekIssue] = useState<IssueWire | null>(null)
  // Scroll-back paging state. Refs, not state: paging must not retrigger the
  // load/subscribe effect, and onEndReached can fire in bursts.
  const paging = useRef<{ head?: string; hasMore: boolean; loading: boolean }>({
    hasMore: false,
    loading: false,
  })

  useEffect(() => {
    let alive = true
    let unsubscribe: (() => void) | null = null
    const cached = store.replica.transcriptWindow(sessionId)
    setItems(cached?.items ?? [])
    setLoaded(false)
    setPendingTurns([])
    setJustSent(false)
    setAnsweredOfferAt(null)
    paging.current = { hasMore: false, loading: false }
    const attach = (since: string | undefined) => {
      if (!alive) return
      unsubscribe = hub.subscribeTranscript(sessionId, since, (delta, meta) => {
        setItems((prev) => (meta.reset ? delta : mergeTranscriptItems(prev, delta)))
      })
    }
    readTranscriptPage(trpc, sessionId)
      .then((page) => {
        if (!alive) return
        setItems(page.items)
        if (page.items.length > 0) store.replica.putTranscriptWindow(sessionId, page.items)
        setLoaded(true)
        paging.current = { head: page.head, hasMore: page.hasMore, loading: false }
        attach(page.tail)
      })
      .catch(() => {
        if (!alive) return
        setLoaded(true)
        attach(undefined)
      })
    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [trpc, hub, sessionId, store.replica])

  // Live deltas extend the same bounded replica window, so a later warm or
  // offline open paints the conversation instead of an empty transcript.
  useEffect(() => {
    if (items.length === 0) return
    store.replica.putTranscriptWindow(sessionId, items)
  }, [items, sessionId, store.replica])

  useEffect(() => {
    if (pendingTurns.length === 0) return
    const echoed = items.filter((item) => item.role === 'user')
    setPendingTurns((prev) => {
      const next = dropEchoedPendingTurns(prev, echoed)
      return next.length === prev.length ? prev : next
    })
  }, [items, pendingTurns.length])

  // The optimistic "working" claim is a bridge to the server's own answer, not
  // a substitute for it. Eight seconds is the desktop's ceiling and the same one
  // applies here: past that, whatever the session reports IS the truth.
  useEffect(() => {
    if (!justSent) return
    const timer = setTimeout(() => setJustSent(false), 8000)
    return () => clearTimeout(timer)
  }, [justSent])

  const fail = useCallback((id: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setPendingTurns((prev) =>
      prev.map((turn) => (turn.id === id ? { ...turn, failed: message } : turn)),
    )
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {})
  }, [])

  const dispatch = useCallback(
    (turn: LocalPendingTurn) => {
      setJustSent(true)
      void store.resumeAndSend(sessionId, turn.wire).catch((error: unknown) => {
        fail(turn.id, error)
      })
    },
    [store.resumeAndSend, sessionId, fail],
  )

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
      const turn: LocalPendingTurn = {
        id: `${Date.now()}:${turnSeq.current++}`,
        text: trimmed,
        wire,
        ...(attached.length > 0 ? { files: attached } : {}),
      }
      setPendingTurns((prev) => [...prev, turn])
      dispatch(turn)
    },
    [dispatch],
  )

  const retry = useCallback(
    (turn: PendingTurn) => {
      const again = { ...(turn as LocalPendingTurn) }
      delete again.failed
      setPendingTurns((prev) =>
        prev.map((candidate) => (candidate.id === turn.id ? again : candidate)),
      )
      dispatch(again)
    },
    [dispatch],
  )

  const loadOlder = useCallback(() => {
    const p = paging.current
    if (!p.hasMore || p.loading || !p.head) return
    p.loading = true
    readTranscriptPage(trpc, sessionId, p.head)
      .then((page) => {
        paging.current = { head: page.head, hasMore: page.hasMore, loading: false }
        setItems((prev) => prependTranscriptItems(prev, page.items))
      })
      .catch(() => {
        paging.current.loading = false
      })
  }, [trpc, sessionId])

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
  const answered = session.offer != null && session.offer.createdAt === answeredOfferAt
  const offer = answered ? undefined : session.offer
  const offerArtifacts = offer
    ? resolveOfferArtifacts({
        offer,
        issue,
        ...(session.lastInputAt ? { lastInputAt: session.lastInputAt } : {}),
      })
    : []
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
  const acceptOffer = (prompt: string, offerCreatedAt: string): Promise<void> => {
    const text = prompt.trim()
    const turn: LocalPendingTurn = {
      id: `${Date.now()}:${turnSeq.current++}`,
      text,
      wire: text,
    }
    setAnsweredOfferAt(offerCreatedAt)
    setPendingTurns((prev) => [...prev, turn])
    setJustSent(true)
    return sendOfferAction(trpc.sessions, {
      sessionId,
      text,
      wake: composer.canResume,
    }).catch((error: unknown) => {
      setAnsweredOfferAt(null)
      fail(turn.id, error)
      throw error
    })
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
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
              onQuote={(text) => setDraftInsertion({ id: insertionSeq.current++, text })}
              bottomInset={composerHeight + askHeight}
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
                    evidenceCount={offerArtifacts.length}
                    onAction={(prompt) => acceptOffer(prompt, offer.createdAt)}
                    // The same write the web x makes: the offer leaves every
                    // surface and every viewer, not just this phone.
                    onDismiss={(offerCreatedAt) => store.dismissOffer(sessionId, offerCreatedAt)}
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
        <View style={styles.composerLayer} pointerEvents="box-none">
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
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  /** Anchored to the KeyboardAvoidingView's padding edge, so it rides the
   *  keyboard without the feed underneath it having to move. */
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
