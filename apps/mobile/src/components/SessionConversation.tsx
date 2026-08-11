import {
  chatActivity,
  composerState,
  defaultChatCapable,
  mergeTranscriptItems,
  prependTranscriptItems,
} from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta, TranscriptItem } from '@podium/model'
import * as Haptics from 'expo-haptics'
import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native'
import { readTranscriptPage, useHub, useIssues, useMobileStore, useSessions } from '../client/hooks'
import { useRefreshableList } from '../hooks/useRefreshableTab'
import { resolveOfferArtifacts } from '../lib/offer-artifacts'
import { FLOW_SLATE, flow, issueColorHex } from '../theme/issueColors'
import { color } from '../theme/theme'
import { Composer } from './Composer'
import { BootstrapCrossfade, TranscriptSkeleton } from './LaunchPlaceholders'
import { PullToRefreshBoundary } from './PullToRefreshBoundary'
import { SessionActionCard } from './SessionActionCard'
import { SessionLifecycle } from './SessionLifecycle'
import { TaskSheet } from './TaskSheet'
import { type PendingTurn, TranscriptList } from './TranscriptList'
import { EmptyState } from './ui'

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
}: {
  session: SessionMeta
  /** The task this session belongs to; drives the colour flow and the plan bridge. */
  issue: IssueWire | undefined
  /** Where a tapped `POD-…` ref in the transcript should go when it is NOT this
   *  task — absent keeps the peek sheet, which is the default everywhere. */
  onOpenTerminalRef?: (issue: IssueWire) => void
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
  const [pendingTurns, setPendingTurns] = useState<PendingTurn[]>([])
  const turnSeq = useRef(0)
  const [draftInsertion, setDraftInsertion] = useState<{ id: number; text: string } | null>(null)
  const insertionSeq = useRef(0)
  // What the feed owes the floating composer. Only ever the RESTING height, so
  // growing the field does not relayout the transcript under the operator.
  const [composerHeight, setComposerHeight] = useState(0)
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
    const echoed = new Set(items.filter((i) => i.role === 'user').map((i) => i.text.trim()))
    setPendingTurns((prev) => {
      const next = prev.filter((turn) => !echoed.has(turn.text.trim()))
      return next.length === prev.length ? prev : next
    })
  }, [items, pendingTurns.length])

  const dispatch = useCallback(
    (id: string, text: string) => {
      void store.resumeAndSend(sessionId, text).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setPendingTurns((prev) =>
          prev.map((turn) => (turn.id === id ? { ...turn, failed: message } : turn)),
        )
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {})
      })
    },
    [store.resumeAndSend, sessionId],
  )

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const id = `${Date.now()}:${turnSeq.current++}`
      setPendingTurns((prev) => [...prev, { id, text: trimmed }])
      dispatch(id, trimmed)
    },
    [dispatch],
  )

  const retry = useCallback(
    (turn: PendingTurn) => {
      setPendingTurns((prev) =>
        prev.map((candidate) =>
          candidate.id === turn.id ? { id: candidate.id, text: candidate.text } : candidate,
        ),
      )
      dispatch(turn.id, turn.text)
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
  const offerArtifacts = session.offer
    ? resolveOfferArtifacts({
        offer: session.offer,
        issue,
        ...(session.lastInputAt ? { lastInputAt: session.lastInputAt } : {}),
      })
    : []
  const accent = issue ? flow.paneBg(issueColorHex(issue.color) ?? FLOW_SLATE) : color.bg
  const activity = chatActivity(session, false)
  // A parked or ended session is present but has no process. It gets the
  // recovery banner; when there is also no conversation to show, the banner is
  // the WHOLE screen rather than a header over an empty transcript [POD-1758].
  const hasTranscript = session.transcriptAvailable ?? defaultChatCapable(session.agentKind)
  const composer = composerState({ session, headless: false, turnRunning: false, compact: false })
  const readOnly = session.status === 'hibernated' || session.status === 'exited'
  const issueTodos = issue?.panel?.todos ?? []
  const todoProgress = issueTodos.length
    ? { done: issueTodos.filter((todo) => todo.done).length, total: issueTodos.length }
    : undefined

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SessionLifecycle
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
              onRetryPending={retry}
              onQuote={(text) => setDraftInsertion({ id: insertionSeq.current++, text })}
              bottomInset={composerHeight}
              todos={todoProgress}
              onOpenTodos={issue ? () => setPeekIssue(issue) : undefined}
              showOpenTodos={session.agentState?.phase === 'idle'}
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
                loaded && items.length === 0 && pendingTurns.length === 0 && !session.offer ? (
                  <EmptyState
                    fill
                    title="No transcript yet"
                    body="Send a message to get things moving."
                  />
                ) : undefined
              }
              onAnswer={async (answer) => {
                await trpc.sessions.answerAskUserQuestion.mutate({ sessionId, ...answer })
              }}
              onLoadOlder={loadOlder}
              onRefPress={(ref) => {
                const seq = Number(ref.slice(4))
                const target = issues.find((i) => i.seq === seq)
                if (!target) return
                if (onOpenTerminalRef) onOpenTerminalRef(target)
                else setPeekIssue(target)
              }}
              footer={
                session.offer ? (
                  <SessionActionCard
                    offer={session.offer}
                    evidenceCount={offerArtifacts.length}
                    onAction={(prompt) => store.resumeAndSend(sessionId, prompt)}
                    onOpenEvidence={issue ? () => setPeekIssue(issue) : undefined}
                  />
                ) : undefined
              }
            />
          </PullToRefreshBoundary>
        </BootstrapCrossfade>
      )}
      {/* The composer floats OVER the feed rather than ending it [POD-502]:
          messages run under the capsule and dissolve into the scrim above it,
          which is what makes it read as lifted off the page rather than welded
          to the bottom edge. The feed pays for it with the composer's own
          resting height. */}
      {readOnly && !hasTranscript ? null : (
        <View style={styles.composerLayer} pointerEvents="box-none">
          <Composer
            placeholder={composer.placeholder}
            onSend={send}
            disabled={!composer.enabled}
            draftInsertion={draftInsertion}
            scrimColor={accent}
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
        onToggleTodo={(index, done) => {
          if (!livePeekIssue) return
          void trpc.issues.panelApply.mutate({
            id: livePeekIssue.id,
            op: done ? 'todo-done' : 'todo-undone',
            index,
          })
        }}
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
})
