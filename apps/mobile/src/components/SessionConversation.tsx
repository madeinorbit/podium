import {
  chatActivity,
  composerState,
  defaultChatCapable,
  latestPendingQuestion,
  mergeTranscriptItems,
  OPTIMISTIC_SEND_CEILING_MS,
  pendingAskFromState,
  prependTranscriptItems,
} from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta, TranscriptItem } from '@podium/model'
import * as Haptics from 'expo-haptics'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import {
  readTranscriptPage,
  useHttpOrigin,
  useHub,
  useIssues,
  useReplica,
  useSessions,
  useStoreActions,
  useTrpc,
} from '../client/hooks'
import { useKeyboardLift } from '../hooks/useKeyboardHeight'
import { useRefreshableList } from '../hooks/useRefreshableTab'
import { dropEchoedPendingTurns } from '../lib/pending-turns'
import { humanizeSendFailure } from '../lib/send-failure'
import { sendOfferAction } from '../lib/send-offer-action'
import { createTrailingWriter } from '../lib/trailing-writer'
import { color, font, leading, sans, space } from '../theme/theme'
import { type AskQuestionAnswer, AskQuestionCard } from './AskQuestionCard'
import { Composer } from './Composer'
import { BootstrapCrossfade, TranscriptSkeleton } from './LaunchPlaceholders'
import { PullToRefreshBoundary } from './PullToRefreshBoundary'
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
type LocalPendingTurn = PendingTurn & { wire: string }

/** How stale the transcript warm-cache may go while deltas stream. The window
 *  is only ever READ on mount, so this bounds crash-loss, not correctness. */
const TRANSCRIPT_PERSIST_DELAY_MS = 1_000

/** The session as the operator has just left it — the answered offer removed,
 *  so every derivation over it agrees with what is on screen. */
function withoutOffer(session: SessionMeta): SessionMeta {
  const { offer: _answered, ...rest } = session
  return rest as SessionMeta
}

/**
 * The transcript's empty state, in the feed's own voice.
 *
 * "Empty" means two different things here, and the old one-liner ("No
 * transcript yet") could not tell them apart. A session that is already
 * computing has a transcript ON ITS WAY — telling the operator to send a
 * message under a working agent reads as the app not knowing what its own
 * agent is doing. That mood gets the working mark, the same braille cell every
 * other surface lights for "an agent is computing". A genuinely idle empty
 * session shows the same cell at rest — unlit, in metadata ink — and hands the
 * next move to the operator, whose composer is directly below.
 */
/**
 * The working mark's dot grid at rest — same cell, no animation, metadata ink.
 * Drawn as SVG rather than the ⣿ text glyph it replaced: the braille block is
 * font-dependent and rendered as a missing-glyph box on device, where the SVG
 * is exactly the geometry every live WorkingMark draws.
 */
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

function EmptyTranscript({ warming }: { warming: boolean }) {
  return (
    <View style={styles.empty} testID="transcript-empty">
      <View style={styles.emptyMark}>
        {warming ? (
          // Adjacent text announces the state, so the mark is decorative here —
          // the same label={null} contract the transcript tail uses.
          <WorkingMark size={24} label={null} />
        ) : (
          <RestingMark size={24} />
        )}
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
  // Narrow subscriptions only: every field this screen reads off the store is
  // an identity-stable static, so the conversation — the hottest surface in
  // the app while an agent streams — no longer re-renders on every store
  // publish (hostMetrics frames, outbox flips, unrelated feed deltas).
  const { resumeAndSend, resurrectSession, killSession, dismissOffer } = useStoreActions()
  const replica = useReplica()
  const httpOrigin = useHttpOrigin()
  const trpc = useTrpc()
  const hub = useHub()
  const issues = useIssues()
  const allSessions = useSessions()
  const sessionId = session.sessionId
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()

  const [items, setItems] = useState<TranscriptItem[]>(
    () => replica.transcriptWindow(sessionId)?.items ?? [],
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
   *
   * IT MUST YIELD THE MOMENT THE SESSION ANSWERS (POD-1595). `chatActivity` now
   * ranks this claim above everything the PREVIOUS turn left behind — an offer,
   * a question, an error — which is right, but only for as long as the claim is
   * still the newest thing anyone knows. A flat timer is not that: an approval
   * raised two seconds into the turn would have sat behind "Sending" for the
   * rest of the window and read as ignored. So the ceiling is a backstop and
   * `agentState.since` is the real signal — any phase change moves it, and the
   * comparison is by VALUE, never against this device's clock.
   */
  const [openSend, setOpenSend] = useState<{
    seq: number
    since: string | null
    /** True when the send went into a turn that was ALREADY running. */
    queuedBehindTurn: boolean
  } | null>(null)
  const justSent = openSend !== null
  const sendSeq = useRef(0)
  // The daemon observation the optimistic claim is made AGAINST — see the
  // ceiling effect below. Written in an effect, not during render.
  const latestSince = useRef<string | undefined>(undefined)
  const latestPhase = useRef<string | undefined>(undefined)
  useEffect(() => {
    latestSince.current = session.agentState?.since
    latestPhase.current = session.agentState?.phase
  }, [session.agentState?.since, session.agentState?.phase])
  const markSent = useCallback((): number => {
    const seq = ++sendSeq.current
    setOpenSend({
      seq,
      since: latestSince.current ?? null,
      queuedBehindTurn: latestPhase.current === 'working' || latestPhase.current === 'compacting',
    })
    return seq
  }, [])
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
  // Each send re-pins the feed to its tail, so the message just written is on
  // screen even if the operator had scrolled up (the web chat's pinToBottom).
  const [pinRequest, setPinRequest] = useState(0)
  const keyboardLift = useKeyboardLift()
  // Scroll-back paging state. Refs, not state: paging must not retrigger the
  // load/subscribe effect, and onEndReached can fire in bursts.
  const paging = useRef<{ head?: string; hasMore: boolean; loading: boolean }>({
    hasMore: false,
    loading: false,
  })

  useEffect(() => {
    let alive = true
    let unsubscribe: (() => void) | null = null
    const cached = replica.transcriptWindow(sessionId)
    setItems(cached?.items ?? [])
    setLoaded(false)
    setPendingTurns([])
    setOpenSend(null)
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
        if (page.items.length > 0) replica.putTranscriptWindow(sessionId, page.items)
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
  }, [trpc, hub, sessionId, replica])

  // Live deltas extend the same bounded replica window, so a later warm or
  // offline open paints the conversation instead of an empty transcript.
  //
  // COALESCED OFF THE STREAMING PATH. `putTranscriptWindow` commits through a
  // SYNCHRONOUS SQLite transaction on the JS thread on native, and this effect
  // fires on every delta — per-delta persistence was paying that commit inside
  // the interaction frame budget several times a second while the operator
  // scrolls and types over a streaming agent. The window is a warm-open cache
  // (read only on mount), so writes trail at most once per
  // TRANSCRIPT_PERSIST_DELAY_MS with the newest items, and flush on unmount,
  // on session switch (the writer is keyed on sessionId) and on app
  // background, so the persisted contract — same call, same payload shape —
  // is unchanged; only the write cadence moved.
  const persistWindow = useMemo(
    () =>
      createTrailingWriter<TranscriptItem[]>((window) => {
        replica.putTranscriptWindow(sessionId, window)
      }, TRANSCRIPT_PERSIST_DELAY_MS),
    [sessionId, replica],
  )
  useEffect(() => {
    if (items.length === 0) return
    persistWindow.schedule(items)
  }, [items, persistWindow])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') persistWindow.flush()
    })
    // The cleanup doubles as the unmount/session-switch flush: a writer's last
    // pending window lands before the next session's writer takes over.
    return () => {
      subscription.remove()
      persistWindow.flush()
    }
  }, [persistWindow])

  useEffect(() => {
    if (pendingTurns.length === 0) return
    const echoed = items.filter((item) => item.role === 'user')
    setPendingTurns((prev) => {
      const next = dropEchoedPendingTurns(prev, echoed)
      return next.length === prev.length ? prev : next
    })
  }, [items, pendingTurns.length])

  // The optimistic claim is a bridge to the server's own answer, not a
  // substitute for it: it ends when the session reports on this turn, and the
  // ceiling only covers a session that reports nothing at all.
  const agentSince = session.agentState?.since
  const agentPhase = session.agentState?.phase
  useEffect(() => {
    if (openSend === null) return
    if ((agentSince ?? null) !== openSend.since) {
      // A send made into a RUNNING turn is a queued one, and the first phase
      // change it sees is that turn ending — not the daemon saying anything
      // about the message still waiting behind it. Spend the flag on a quiet
      // finish only; anything else (an ask raised mid-turn, an error) is news
      // the operator needs more than they need our receipt.
      if (openSend.queuedBehindTurn && agentPhase === 'idle') {
        setOpenSend({ ...openSend, since: agentSince ?? null, queuedBehindTurn: false })
        return
      }
      setOpenSend(null)
      return
    }
    // The ceiling is for a session saying NOTHING. One visibly working is
    // saying plenty, just about the turn ahead of ours.
    if (openSend.queuedBehindTurn && (agentPhase === 'working' || agentPhase === 'compacting')) {
      return
    }
    const timer = setTimeout(() => setOpenSend(null), OPTIMISTIC_SEND_CEILING_MS)
    return () => clearTimeout(timer)
  }, [openSend, agentSince, agentPhase])

  const fail = useCallback((id: string, error: unknown, seq?: number) => {
    const message = humanizeSendFailure(error)
    setPendingTurns((prev) =>
      prev.map((turn) => (turn.id === id ? { ...turn, failed: message } : turn)),
    )
    // A REFUSED send is not in flight. Leaving the optimistic claim open would
    // keep "Sending" over the tail — now above the session's own error and
    // attention lines — for the rest of the window, next to a bubble that has
    // just gone red. Scoped to the send that failed: these resolve out of
    // order, and a slow rejection must not close a later send's window.
    if (seq !== undefined) setOpenSend((current) => (current?.seq === seq ? null : current))
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {})
  }, [])

  const shellSession = session.agentKind === 'shell'
  const dispatch = useCallback(
    (turn: LocalPendingTurn) => {
      const mySend = markSent()
      setPinRequest((count) => count + 1)
      void resumeAndSend(sessionId, turn.wire)
        .then(() => {
          // A shell session's input lands in the PTY, not the chat: no message
          // entity ever comes back for `dropEchoedPendingTurns` to match, so an
          // optimistic row left waiting for its echo said "sending…" for the
          // rest of the visit (2026-08-27 device feedback #2, the shell half).
          // The delivery ack IS this turn's terminal state — retire the row on
          // it. Chat harnesses keep waiting for the echo, so their bubble never
          // blinks out and back between ack and transcript.
          if (shellSession) {
            setPendingTurns((prev) => prev.filter((pending) => pending.id !== turn.id))
          }
        })
        .catch((error: unknown) => {
          fail(turn.id, error, mySend)
        })
    },
    [resumeAndSend, sessionId, fail, markSent, shellSession],
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
  // The empty feed's mood. `starting` is checked on its own because a freshly
  // spawned agent is booting before `agentState` has anything to say — exactly
  // the window in which the empty state is on screen the longest.
  const warming = session.status === 'starting' || activity?.tone === 'working'
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
    const mySend = markSent()
    setPinRequest((count) => count + 1)
    return sendOfferAction(trpc.sessions, {
      sessionId,
      text,
      wake: composer.canResume,
    }).catch((error: unknown) => {
      setAnsweredOfferAt(null)
      fail(turn.id, error, mySend)
      throw error
    })
  }

  return (
    /* THE VIEW NEVER RESIZES; THE COMPOSER RISES.
       This used to be a `KeyboardAvoidingView` in 'height' mode, which shrank
       the whole conversation so the absolute composer layer (anchored to this
       view's bottom edge) would ride up with it. Backgrounding the app with the
       keyboard open and returning left that arithmetic in a state where the view
       collapsed to a sliver: the composer stranded at the top of a black screen
       (2026-08-29, operator screenshot, reproduced on the simulator). The
       keyboard's overlap is an absolute measurement — see useKeyboardHeight —
       so the layer is lifted by it directly, and the feed pays for the same
       distance in its bottom inset. Nothing here has a frame to remember. */
    <View style={styles.flex}>
      <MobileSessionLifecycle
        session={session}
        hasTranscript={hasTranscript}
        onResume={resurrectSession}
        onRemove={killSession}
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
              assetContext={{ httpOrigin, sessionId, cwd: session.cwd }}
              pendingTurns={pendingTurns}
              hidePendingQuestion
              findRequest={findRequest}
              pinRequest={pinRequest}
              onRetryPending={retry}
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
                    // The offer draws its own evidence [POD-120]; the issue and
                    // the input stamp are what its artifact paths resolve against.
                    {...(issue ? { issue } : {})}
                    {...(session.lastInputAt ? { lastInputAt: session.lastInputAt } : {})}
                    onAction={(prompt) => acceptOffer(prompt, offer.createdAt)}
                    // The same write the web x makes: the offer leaves every
                    // surface and every viewer, not just this phone.
                    onDismiss={(offerCreatedAt) => dismissOffer(sessionId, offerCreatedAt)}
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
  /** Anchored to the conversation's bottom edge and lifted by the keyboard's
   *  own overlap, so it rides the keyboard without the view resizing. */
  composerLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  askLayer: {
    backgroundColor: color.engraved,
  },
  /** Claims the leftover feed height so whatever floats below (the composer)
   *  stays where it is — the same contract the old EmptyState `fill` had. */
  empty: {
    flex: 1,
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.xxl,
    paddingVertical: space.xxl,
  },
  /** One fixed box for both moods, so the mark swapping from resting glyph to
   *  working cell moves no text under the reader. */
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
