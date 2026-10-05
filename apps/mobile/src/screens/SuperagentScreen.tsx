import type { SuperagentTurnFailure } from '@podium/client-core/api'
import { useModelCatalog } from '@podium/client-core/react'
import { createTranscriptController, type TranscriptState } from '@podium/client-core/transcript'
import type { SuperagentSliceValue } from '@podium/client-core/values'
import { buildImagePrompt, matchesQuestionInteraction } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { superagentQuestion, superagentState } from '@podium/client-graph/superagent'
import { asThreadId, type SessionId } from '@podium/model'
import * as Haptics from 'expo-haptics'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useHttpOrigin, useHub, useReplica, useStoreActions, useTrpc } from '../client/hooks'
import { useMobilePoolProjection } from '../client/mobile-pool'
import type { MobileTrpc } from '../client/trpc'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { Eraser } from '../components/icons'
import { BootstrapCrossfade, TranscriptSkeleton } from '../components/LaunchPlaceholders'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { HeaderButton, Screen } from '../components/Screen'
import { SuperagentBackendRail } from '../components/SuperagentBackendRail'
import { type PendingTurn, TranscriptList } from '../components/TranscriptList'
import { EmptyState } from '../components/ui'
import { type SentAttachment, useComposerAttachments } from '../components/useComposerAttachments'
import { useKeyboardLift } from '../hooks/useKeyboardHeight'
import { useRefreshableList } from '../hooks/useRefreshableTab'
import { useTabBarInset } from '../hooks/useTabBarInset'
import { humanizeSendFailure } from '../lib/send-failure'
import {
  applySuperagentModelPick,
  resolveSuperagentBackend,
  type SuperagentBackendPick,
  superagentTurnChoice,
} from '../lib/superagent-backend'
import { liveTranscriptItem, markTurnsFailed } from '../lib/superagent-transcript'
import { color, font, sans, space } from '../theme/theme'

/**
 * The Superagent — the phone half of the engraved column's chat [POD-338].
 * It is the desktop surface, not a variant of it:
 *
 *  - ONE thread, always `global` (desktop `THREAD_ID`). Per-thread history is
 *    not a phone decision.
 *  - The SAME Flat Field transcript the session chat renders (the desktop
 *    embeds `ChatView` here for exactly this reason) instead of a second,
 *    bespoke chat vocabulary — and, since POD-344, over the same SOURCE: the
 *    thread's headless session transcript, and only that. `superagent.history`
 *    is the frozen legacy buffer, so a screen built on it rendered neither the
 *    turn it just sent nor the reply — the phone hung on "sending" forever.
 *    The desktop reads none of it and neither does this; see
 *    ../lib/superagent-transcript for why folding it back in is a trap.
 *  - Laid out like every other tab: the large Screen header Work and Tasks
 *    wear, one scroller, composer docked above the tab bar. Model and effort
 *    sit under the well, same contract as the desktop prompt-box rail.
 */
const THREAD_ID = asThreadId('global')
const EMPTY_TRANSCRIPT: Pick<
  TranscriptState,
  | 'items'
  | 'initialLoaded'
  | 'pendingQuestion'
  | 'latestRecordedAt'
  | 'hasMoreOlder'
  | 'loadingOlder'
> = {
  items: [],
  initialLoaded: false,
  pendingQuestion: null,
  latestRecordedAt: null,
  hasMoreOlder: false,
  loadingOlder: false,
}
const emptyTranscript = () => EMPTY_TRANSCRIPT
const subscribeEmptyTranscript = () => () => {}

type LocalPendingTurn = PendingTurn & { wire: string }

const EMPTY_SUPERAGENT: SuperagentSliceValue & { booting: boolean; loading: boolean } = {
  threads: [],
  active: undefined,
  activeSessionId: undefined,
  booting: true,
  loading: true,
}
function usePoolSuperagent() {
  return useMobilePoolProjection(superagentState, EMPTY_SUPERAGENT)
}
function usePoolQuestion(id: SessionId | undefined) {
  const read = useCallback((pool: MobxPool) => superagentQuestion(pool, id).question, [id])
  return useMobilePoolProjection(read, undefined)
}
function usePoolTranscriptSession(id: SessionId | undefined) {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.session(id), [id])
  return useMobilePoolProjection(read, undefined)
}

export function SuperagentScreen() {
  // Narrow subscriptions: everything this screen reads off the store is
  // either an identity-stable static or the sessions slice it paints from.
  const trpc = useTrpc()
  const { refreshSuperThreads } = useStoreActions()
  const replica = useReplica()
  const httpOrigin = useHttpOrigin()
  const hub = useHub()
  // The signed-in user's threads, from the store's published slice — the same
  // one the desktop superagent column reads. The screen used to fetch the list
  // itself on mount AND poll it on a 5s interval, which is a second copy of
  // state the store already holds, with its own staleness.
  //
  // The slice keys on `store.superThreadId`, which is 'global' by default and
  // which this screen never changes: one thread, always global, is the phone's
  // whole superagent model. `threadById` is deliberately not
  // used — the slice exposes no lookup that takes a bare id and goes looking,
  // which is what makes another user's thread unaddressable from here
  // (doc §3.1.6 S2).
  const superagent = usePoolSuperagent()
  const booting = superagent.booting
  const tabBarInset = useTabBarInset()
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()
  const [threadsLoaded, setThreadsLoaded] = useState(false)
  const [liveText, setLiveText] = useState('')
  const pendingLiveText = useRef('')
  const pendingLiveTextActivity = useRef(0)
  const liveTextFrame = useRef<number | null>(null)
  const liveTextCommit = useRef(0)
  const activityVersion = useRef(0)
  const [statusLabel, setStatusLabel] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  // The hand-off is already visible work. Keep it separate from the server's
  // query-backed flag so an old `turnRunning: false` snapshot cannot erase the
  // mark between pressing Send and the first turn-start frame (web calls this
  // narrow state `justSent`).
  const [justSent, setJustSent] = useState(false)
  const working = running || justSent
  // A query `false` is authoritative only after this mount has first observed
  // `true`. Before that it is usually the pre-send snapshot, not proof that the
  // new turn already ended.
  const querySawRunning = useRef(false)
  const [error, setError] = useState<string | null>(null)
  // The thread's headless session: the slice's answer, until a turn's ack hands
  // back a fresher one (the FIRST turn learns its session from the ack alone).
  const [ackedSid, setAckedSid] = useState<SessionId | undefined>(undefined)
  // A successful clear kills the old headless session before the store refresh
  // necessarily removes its binding. Keep that stale id hidden locally so an
  // immediate attachment cannot revive it during the refresh window.
  const [clearedSid, setClearedSid] = useState<SessionId | undefined>(undefined)
  const publishedSid =
    superagent.activeSessionId === clearedSid ? undefined : superagent.activeSessionId
  const podiumSid = ackedSid ?? publishedSid
  const followingTranscript = useRef(true)
  const searchingTranscript = useRef(false)
  const followTranscript = useCallback((following: boolean) => {
    followingTranscript.current = following
  }, [])
  const searchTranscript = useCallback((searching: boolean) => {
    searchingTranscript.current = searching
  }, [])
  const transcriptController = useMemo(
    () =>
      podiumSid === undefined
        ? undefined
        : createTranscriptController({
            sessionId: podiumSid,
            initialLimit: 80,
            pageLimit: 80,
            questions: ['userEcho', 'latestRecordedAt'],
            retainHistory: () => !followingTranscript.current || searchingTranscript.current,
            source: {
              read: (request) => trpc.sessions.transcriptRead.query(request),
              subscribe: (sid, since, listener) => hub.subscribeTranscript(sid, since, listener),
            },
            cache: {
              read: (sid) => replica.transcriptWindow(sid),
              write: (sid, next) => replica.putTranscriptWindow(sid, [...next]),
            },
          }),
    [hub, podiumSid, replica, trpc.sessions.transcriptRead],
  )
  const transcript = useSyncExternalStore<typeof EMPTY_TRANSCRIPT>(
    transcriptController?.subscribe ?? subscribeEmptyTranscript,
    transcriptController?.getSnapshot ?? emptyTranscript,
  )
  const items = transcript.items
  const transcriptLoaded = transcript.initialLoaded
  const currentQuestion = usePoolQuestion(podiumSid)
  const transcriptSession = usePoolTranscriptSession(podiumSid)
  const modelCatalog = useModelCatalog<MobileTrpc>(transcriptSession?.machineId)
  const [backendPick, setBackendPick] = useState<SuperagentBackendPick>({})
  const backend = useMemo(
    () => resolveSuperagentBackend(superagent.active, backendPick),
    [superagent.active, backendPick],
  )
  const [pendingTurns, setPendingTurns] = useState<LocalPendingTurn[]>([])
  // The most recent durable turn failure (POD-4806): restored from the typed
  // `latestTurnFailure` read once the transcript is in, and rendered as a
  // failed row beside the live pending turns. Held apart from `pendingTurns`
  // on purpose — the echo matcher below compares words, and the restoration
  // must be dropped by structure only (a newer transcript item, or live
  // send activity), never by text.
  const [restoredFailure, setRestoredFailure] = useState<SuperagentTurnFailure | null>(null)
  // Live activity takes over this mount. Invalidate reads already in flight,
  // and avoid starting restoration after a send that precedes transcript load.
  const failureActivityVersion = useRef(0)
  const clearRestoredFailure = useCallback(() => {
    failureActivityVersion.current += 1
    setRestoredFailure(null)
  }, [])
  const prepareAttachmentSession = useCallback(async (): Promise<SessionId> => {
    if (podiumSid) return podiumSid
    const result = await trpc.superagent.ensureSession.mutate({ threadId: THREAD_ID })
    if (!result.podiumSessionId) throw new Error('Superagent could not prepare this attachment.')
    setAckedSid(result.podiumSessionId)
    return result.podiumSessionId
  }, [podiumSid, trpc.superagent.ensureSession])
  const attachments = useComposerAttachments(podiumSid, {
    prepareSession: prepareAttachmentSession,
  })
  const [draftInsertion, setDraftInsertion] = useState<{ id: number; text: string } | null>(null)
  const insertionSeq = useRef(0)
  // Each send re-pins the feed to its tail so the just-written turn is on
  // screen even if the operator had scrolled up (the web chat's pinToBottom).
  const [pinRequest, setPinRequest] = useState(0)
  const keyboardLift = useKeyboardLift()
  // Monotonic per-mount counter behind each optimistic row's id. Date.now()
  // alone collides when two sends land in the same millisecond.
  const turnSeq = useRef(0)

  const cancelLiveTextFrame = useCallback(() => {
    // A callback can already be dequeued when cancellation runs. Invalidate its
    // commit token as well as asking the host to cancel it.
    liveTextCommit.current += 1
    if (liveTextFrame.current === null) return
    cancelAnimationFrame(liveTextFrame.current)
    liveTextFrame.current = null
  }, [])

  const clearLiveText = useCallback(() => {
    activityVersion.current += 1
    cancelLiveTextFrame()
    pendingLiveText.current = ''
    setLiveText('')
  }, [cancelLiveTextFrame])

  // Headless partial-text frames are cumulative and can arrive much faster than
  // the display. Keep only the newest frame and let React parse/paint it once in
  // the next animation frame instead of doing that work for every socket event.
  const queueLiveText = useCallback((text: string, eventVersion: number) => {
    pendingLiveText.current = text
    pendingLiveTextActivity.current = eventVersion
    if (liveTextFrame.current !== null) return
    const commit = ++liveTextCommit.current
    liveTextFrame.current = requestAnimationFrame(() => {
      if (commit !== liveTextCommit.current) return
      liveTextFrame.current = null
      const next = pendingLiveText.current
      setLiveText((current) => (current === next ? current : next))
      // A status event received after this partial owns the label. The delayed
      // text paint may update prose, but it must not erase newer activity.
      if (pendingLiveTextActivity.current === activityVersion.current) setStatusLabel(null)
    })
  }, [])

  // The store owns the thread list; this completion bit only distinguishes an
  // unresolved first read from a genuinely empty global thread. The engine's
  // boot refresh may already have won, in which case this is a cheap refresh.
  useEffect(() => {
    let alive = true
    void refreshSuperThreads()
      .catch(() => {})
      .finally(() => {
        if (alive) setThreadsLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [refreshSuperThreads])

  // Opening the tab mid-turn shows the mark: the thread carries a query-backed
  // running flag for exactly this late-join case, because headlessActivity
  // frames are ephemeral. A later false clears a missed turn-end only when this
  // mount first saw the corresponding true; a stale pre-send false must not
  // cancel the optimistic hand-off above.
  useEffect(() => {
    if (superagent.active?.turnRunning === true) {
      clearRestoredFailure()
      querySawRunning.current = true
      setRunning(true)
      setJustSent(false)
      return
    }
    if (superagent.active?.turnRunning === false && querySawRunning.current) {
      querySawRunning.current = false
      setRunning(false)
      clearLiveText()
      setStatusLabel(null)
    }
  }, [clearLiveText, clearRestoredFailure, superagent.active?.turnRunning])

  // The conversation itself, read and streamed from the thread's headless
  // session exactly as SessionScreen does for a normal chat.
  useEffect(() => {
    if (!transcriptController) return
    void transcriptController.start()
    return () => transcriptController.stop()
  }, [transcriptController])

  // DURABLE FAILURE RESTORATION (POD-4806). A turn that never reached a
  // harness leaves no transcript and the live turn-end error is gone after a
  // reload — the Super thread then reads empty, as if nothing was sent. The
  // typed `latestTurnFailure` read names the failure server-side (by column,
  // never by matching prose), so the remount restores it as a failed row
  // with one-tap retry. Without user words (a post-dispatch failure, whose
  // prompt the transcript carries) only the reason restores — never a second
  // user bubble.
  useEffect(() => {
    setRestoredFailure(null)
    if (!podiumSid || !transcriptLoaded || failureActivityVersion.current > 0) return
    let cancelled = false
    const requestedAtVersion = failureActivityVersion.current
    void trpc.superagent.latestTurnFailure
      .query({ threadId: THREAD_ID })
      .then((failure) => {
        if (cancelled || failureActivityVersion.current !== requestedAtVersion || !failure) return
        setRestoredFailure(failure)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [podiumSid, transcriptLoaded, trpc])

  const loadOlder = useCallback(() => {
    void transcriptController?.loadOlder().catch(() => {})
  }, [transcriptController])

  // Live turn activity: the in-progress assistant text and the turn boundaries.
  // The settled reply arrives on the transcript stream, so turn-end only has to
  // put the chrome back.
  useEffect(() => {
    if (!podiumSid) return
    const unsubscribe = hub.subscribeHeadless(podiumSid, (event) => {
      const eventVersion = ++activityVersion.current
      clearRestoredFailure()
      if (event.kind === 'turn-start') {
        setRunning(true)
        setJustSent(false)
        clearLiveText()
        setStatusLabel('starting')
      } else if (event.kind === 'turn-end') {
        setRunning(false)
        setJustSent(false)
        querySawRunning.current = false
        clearLiveText()
        setStatusLabel(null)
        setError(event.error ?? null)
        if (event.error) {
          const reason = event.error
          // The OTHER way a turn fails (POD-344). POD-346 marks a row "not sent"
          // when the mutation is rejected — but a turn that is ACCEPTED and then
          // dies (harness crash, spawn failure) resolves that mutation, so its
          // catch never runs, and a dead turn writes no transcript for
          // the transcript's echo relation to match. Without this the row says "sending…" for
          // ever. The writer lock is released at turn-end and the server refuses
          // a second concurrent turn, so anything still pending is this turn's.
          setPendingTurns((prev) => [...markTurnsFailed(prev, reason)])
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {})
        }
      } else if (event.kind === 'status') {
        setStatusLabel(event.status === 'tool' ? (event.label ?? 'tool') : event.status)
      } else if ('text' in event && typeof event.text === 'string') {
        queueLiveText(event.text, eventVersion)
      }
    })
    return () => {
      unsubscribe()
      cancelLiveTextFrame()
    }
  }, [cancelLiveTextFrame, clearLiveText, clearRestoredFailure, hub, podiumSid, queueLiveText])

  // headlessActivity frames are ephemeral, and the FIRST turn only learns its
  // session from the ack — so the subscription can attach after that turn's
  // turn-end and the spinner would never stop. The server's query-backed flag
  // is the late-joiner truth; it only ever CLEARS a stuck spinner here, so it
  // cannot race a turn that was just dispatched.
  useEffect(() => {
    if (!working) return
    // Refresh the STORE's thread list rather than querying a private copy: the
    // slice above then reports the flag, and one refetch serves every reader.
    const id = setInterval(() => void refreshSuperThreads().catch(() => {}), 5000)
    return () => clearInterval(id)
  }, [working, refreshSuperThreads])

  // The settled conversation IS the session transcript — see superagent-transcript.ts
  // for why the legacy buffer is not folded in.
  const settled = items

  // Drop an optimistic turn once the transcript carries it.
  useEffect(() => {
    if (!transcriptController || pendingTurns.length === 0) return
    const reconcile = () => setPendingTurns((previous) => {
      const next = previous.filter(
        (turn) =>
          !transcriptController.hasUserEcho(
            turn.text,
            (turn.files ?? []).map((file) => file.path),
          ),
      )
      return next.length === previous.length ? previous : next
    })
    reconcile()
    return transcriptController.subscribe(reconcile)
  }, [transcriptController, pendingTurns.length])

  // Once the transcript has echoed the optimistic row, transport is complete.
  // Real computation keeps its own `running` mark; a very fast completed turn
  // simply settles back to Idle without leaving a local loader stuck behind.
  useEffect(() => {
    if (justSent && pendingTurns.length === 0) setJustSent(false)
  }, [justSent, pendingTurns.length])

  // One dispatch, keyed by the optimistic row it owns. A rejection marks THAT
  // row "not sent" with the reason and leaves the words on screen to retry
  // (POD-346) — the old path only set a banner, which reads as "nothing
  // happened" when the reason is a stuck turn or an offline server.
  const dispatch = useCallback(
    (id: string, wire: string) => {
      setJustSent(true)
      setPinRequest((count) => count + 1)
      // A fresh send supersedes any restored failure: live activity speaks
      // for the thread now (the restoration drops by structure anyway, but
      // clearing the state keeps it from resurfacing once the live rows
      // drain).
      clearRestoredFailure()
      setError(null)
      void trpc.superagent.sendTurn
        .mutate({ threadId: THREAD_ID, text: wire, ...superagentTurnChoice(backend) })
        .then((ack) => {
          if (ack?.podiumSessionId) setAckedSid(ack.podiumSessionId)
          void refreshSuperThreads().catch(() => {})
        })
        .catch((e: unknown) => {
          const message = humanizeSendFailure(e)
          setRunning(false)
          setJustSent(false)
          setPendingTurns((prev) =>
            prev.map((turn) => (turn.id === id ? { ...turn, failed: message } : turn)),
          )
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {})
        })
    },
    [trpc, backend, refreshSuperThreads, clearRestoredFailure],
  )

  const send = useCallback(
    (text: string, files?: readonly SentAttachment[]) => {
      const trimmed = text.trim()
      const attached = files ?? []
      if (!trimmed && attached.length === 0) return
      // Counter, not text length: two identical messages inside one millisecond
      // would share an id, and `failed`/retry address a row BY id.
      const id = `${Date.now()}:${turnSeq.current++}`
      const wire = buildImagePrompt(
        attached.map((file) => file.path),
        trimmed,
      )
      setPendingTurns((prev) => [
        ...prev,
        {
          id,
          text: trimmed,
          wire,
          ...(attached.length > 0 ? { files: attached } : {}),
        },
      ])
      dispatch(id, wire)
    },
    [dispatch],
  )

  const retry = useCallback(
    (turn: PendingTurn) => {
      // A restored failure becomes a live turn: seed it into the live list
      // (which itself drops the restoration) and dispatch. Matched by row
      // identity against the restoration's input id, never by comparing
      // words.
      if (restoredFailure?.userText && turn.id === `restored:${restoredFailure.inputId}`) {
        const live: LocalPendingTurn = {
          id: `retry:${restoredFailure.inputId}:${Date.now()}`,
          text: restoredFailure.userText,
          wire: restoredFailure.userText,
        }
        setPendingTurns((prev) => [...prev, live])
        dispatch(live.id, live.wire)
        return
      }
      const local = pendingTurns.find((candidate) => candidate.id === turn.id)
      if (!local) return
      setPendingTurns((prev) =>
        prev.map((t) => {
          if (t.id !== turn.id) return t
          const { failed: _failed, ...retrying } = t
          return retrying
        }),
      )
      dispatch(local.id, local.wire)
    },
    [dispatch, pendingTurns, restoredFailure],
  )

  const interrupt = useCallback(async () => {
    try {
      await trpc.superagent.interruptTurn.mutate({ threadId: THREAD_ID })
      setRunning(false)
      setJustSent(false)
      querySawRunning.current = false
    } catch {
      // already stopped
    }
  }, [trpc])

  const clear = useCallback(async () => {
    try {
      await trpc.superagent.clear.mutate({ threadId: THREAD_ID })
      // The server drops the thread's harness+headless binding, so the old
      // session's transcript is no longer this thread's: forget it and let the
      // next turn's ack hand back a fresh session.
      setClearedSid(podiumSid)
      setAckedSid(undefined)
      attachments.clear()
      void refreshSuperThreads().catch(() => {})
      setPendingTurns([])
      clearRestoredFailure()
      setError(null)
      clearLiveText()
      setRunning(false)
      setJustSent(false)
      querySawRunning.current = false
    } catch (e) {
      setError(humanizeSendFailure(e))
    }
  }, [attachments.clear, clearLiveText, clearRestoredFailure, podiumSid, refreshSuperThreads, trpc])

  // Keep the high-frequency live row outside the settled transcript. This
  // preserves the settled array's identity and its cached paired/row model.
  const liveItem = useMemo(() => liveTranscriptItem(liveText, running), [liveText, running])
  // Apply the same structural rule to the restored reason and retry row,
  // including post-dispatch failures whose userText is null. Dropped by
  // structure, never by comparing words: a transcript item recorded after the
  // failure means a later turn ran, and live send activity means this mount
  // is already speaking for itself — either way the old row must not pin the
  // thread.
  const visibleRestoredFailure = useMemo(() => {
    if (!restoredFailure || pendingTurns.length > 0 || working) return null
    const failureAt = Date.parse(restoredFailure.at)
    if (
      Number.isFinite(failureAt) &&
      transcript.latestRecordedAt !== null &&
      transcript.latestRecordedAt > failureAt
    )
      return null
    return restoredFailure
  }, [restoredFailure, transcript.latestRecordedAt, pendingTurns.length, working])
  const restoredRow = useMemo((): LocalPendingTurn | null => {
    if (!visibleRestoredFailure?.userText) return null
    return {
      id: `restored:${visibleRestoredFailure.inputId}`,
      text: visibleRestoredFailure.userText,
      wire: visibleRestoredFailure.userText,
      failed: visibleRestoredFailure.error,
    }
  }, [visibleRestoredFailure])
  const visibleError = error ?? visibleRestoredFailure?.error ?? null
  const visiblePendingTurns = useMemo(
    () => (restoredRow ? [...pendingTurns, restoredRow] : pendingTurns),
    [pendingTurns, restoredRow],
  )
  // POD-332 retired `MobileClientValue` (and with it `client.sessionById`): every
  // screen reads the same store and the same published slices as the web.
  const transcriptResolved = podiumSid
    ? transcriptLoaded || settled.length > 0 || liveItem !== undefined
    : threadsLoaded
  const resolved = !booting && transcriptResolved
  const empty =
    resolved &&
    settled.length === 0 &&
    liveItem === undefined &&
    visiblePendingTurns.length === 0 &&
    !working

  return (
    <Screen
      large
      title="Superagent"
      right={
        <>
          {running ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Stop turn"
              onPress={() => void interrupt()}
              hitSlop={8}
            >
              <Text style={styles.stop}>Stop</Text>
            </PressableScale>
          ) : null}
          <HeaderButton label="Clear context — start the chat fresh" onPress={() => void clear()}>
            <Icon as={Eraser} size={15} color={color.textDim} />
          </HeaderButton>
        </>
      }
    >
      <View style={styles.column}>
        {/* The composer rides the keyboard on the view's own bottom edge — see
            useKeyboardHeight for why this is not a KeyboardAvoidingView. */}
        <View style={[styles.flex, { paddingBottom: keyboardLift }]}>
          {visibleError ? <Text style={styles.error}>{visibleError}</Text> : null}
          <BootstrapCrossfade resolved={resolved} placeholder={<TranscriptSkeleton />}>
            <PullToRefreshBoundary
              connected={connected}
              refreshing={refreshing}
              onRefresh={onRefresh}
            >
              <TranscriptList
                items={settled}
                transcriptQuestion={transcript.pendingQuestion}
                liveItem={liveItem}
                live={working}
                collapseContext
                assetContext={
                  podiumSid && transcriptSession
                    ? {
                        httpOrigin,
                        sessionId: podiumSid,
                        cwd: transcriptSession.cwd,
                      }
                    : undefined
                }
                pendingTurns={visiblePendingTurns}
                pinRequest={pinRequest}
                onRetryPending={retry}
                onQuote={(text) => setDraftInsertion({ id: insertionSeq.current++, text })}
                streaming={liveItem !== undefined}
                tail={{
                  label: working
                    ? justSent && !running
                      ? 'Sending'
                      : (statusLabel ?? 'Working')
                    : 'Idle',
                  tone: working ? 'working' : 'idle',
                }}
                onLoadOlder={loadOlder}
                moreAbove={transcript.hasMoreOlder}
                loadingOlder={transcript.loadingOlder}
                onFollowChange={followTranscript}
                onSearchChange={searchTranscript}
                refreshControl={refreshControl}
                refreshAccessibilityProps={refreshAccessibilityProps}
                emptyComponent={
                  empty ? (
                    <EmptyState
                      fill
                      title="Hand off some work"
                      body="The superagent can read your repos, file tasks, spawn worker sessions and steer them — describe what you want done."
                    />
                  ) : undefined
                }
                answerInteractionId={currentQuestion?.id}
                onAnswer={async (answer) => {
                  if (
                    currentQuestion &&
                    (answer.interactionId !== currentQuestion.id ||
                      !answer.question ||
                      !matchesQuestionInteraction(currentQuestion, answer.question))
                  ) {
                    throw new Error('The question changed; wait for the current menu.')
                  }
                  if (!podiumSid) return
                  const sent = await trpc.sessions.answerAskUserQuestion.mutate({
                    sessionId: podiumSid,
                    interactionId: answer.interactionId,
                    ...answer,
                  })
                  if (sent?.ok === false) throw new Error(sent.reason ?? 'answer not delivered')
                }}
              />
            </PullToRefreshBoundary>
          </BootstrapCrossfade>
          {/* The tab bar floats over the content now, so the composer has to
              hold itself above it — it is the one thing on this screen that
              must never be scrolled under [POD-420]. The bar's measured inset
              already includes the bottom safe area, so it replaces rather than
              stacks with the composer's own [POD-502]. */}
          <Composer
            placeholder="Delegate a task…"
            onSend={send}
            draftInsertion={draftInsertion}
            attachments={attachments}
            bottomInset={tabBarInset}
            leading={
              <SuperagentBackendRail
                backend={backend}
                modelCatalog={modelCatalog}
                onModelChange={(model, agentKind) =>
                  setBackendPick((pick) => applySuperagentModelPick(pick, model, agentKind))
                }
                onEffortChange={(effort) => setBackendPick((pick) => ({ ...pick, effort }))}
              />
            }
          />
        </View>
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  column: {
    flex: 1,
    minHeight: 0,
    backgroundColor: color.engraved,
  },
  flex: {
    flex: 1,
    minHeight: 0,
  },
  stop: {
    ...sans(700),
    color: color.dangerText,
    fontSize: font.small,
  },
  error: {
    ...sans(400),
    color: color.dangerText,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingBottom: space.xs,
  },
})
