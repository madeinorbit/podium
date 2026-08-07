import { groupSessions, withoutShells } from '@podium/client-core/focus'
import {
  agentBadge,
  chatActivity,
  mergeTranscriptItems,
  panelLabel,
  prependTranscriptItems,
  sessionDotTone,
  sessionTitle,
} from '@podium/client-core/viewmodels'
import type { TranscriptItem, WorkState } from '@podium/model'
import { asSessionId, snoozeUntil1h, snoozeUntilTomorrow5am } from '@podium/model'
import * as Haptics from 'expo-haptics'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { MoreVertical, SquareTerminal } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native'
import {
  readTranscriptPage,
  useBooting,
  useHub,
  useIssue,
  useIssues,
  useMobileStore,
  useSession,
  useSessions,
} from '../client/hooks'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { IdSquare } from '../components/IdSquare'
import {
  BootstrapCrossfade,
  DetailSkeleton,
  TranscriptSkeleton,
} from '../components/LaunchPlaceholders'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionActionCard } from '../components/SessionActionCard'
import { TaskPeekSheet } from '../components/TaskPeekSheet'
import { type PendingTurn, TranscriptList } from '../components/TranscriptList'
import { EmptyState } from '../components/ui'
import { useRefreshableList } from '../hooks/useRefreshableTab'
import { resolveOfferArtifacts } from '../lib/offer-artifacts'
import { hasSessionBackTarget, sessionBackTarget, sessionHref } from '../lib/session-route'
import { FLOW_SLATE, issueColorHex } from '../theme/issueColors'
import { color } from '../theme/theme'
import { sessionAbsence } from './session-absence'

const WORK_STATES: (WorkState | null)[] = [
  'planning',
  'implementing',
  'testing',
  'done',
  'icebox',
  null,
]

export function SessionScreen() {
  // Route params are RAW URL values, so the type stays `string` and the brand is
  // applied once here — the DECODE EDGE for this screen (POD-362).
  const params = useLocalSearchParams<{
    sessionId: string | string[]
    backTo?: string | string[]
  }>()
  const rawSessionId = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId
  const sessionId = rawSessionId ? asSessionId(rawSessionId) : undefined
  const backTarget = sessionBackTarget(params.backTo)
  const hasBackTarget = hasSessionBackTarget(params.backTo)
  const router = useRouter()
  const store = useMobileStore()
  const hub = useHub()
  const allSessions = useSessions()
  const issues = useIssues()
  const session = useSession(sessionId)
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()
  const booting = useBooting()

  const [items, setItems] = useState<TranscriptItem[]>(() =>
    sessionId ? (store.replica.transcriptWindow(sessionId)?.items ?? []) : [],
  )
  const [loaded, setLoaded] = useState(false)
  // Turns sent from this screen, painted until the server echoes them into the
  // transcript (POD-338). A parked session queues the message and answers
  // minutes later — without this the composer reads as if it never sent.
  const [pendingTurns, setPendingTurns] = useState<PendingTurn[]>([])
  const turnSeq = useRef(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [workMenuOpen, setWorkMenuOpen] = useState(false)
  const [draftInsertion, setDraftInsertion] = useState<{ id: number; text: string } | null>(null)
  const insertionSeq = useRef(0)
  const goBack = useCallback(() => {
    if (hasBackTarget) {
      router.dismissTo(backTarget)
      return
    }
    router.replace('/work')
  }, [backTarget, hasBackTarget, router])
  const [peekIssue, setPeekIssue] = useState<import('@podium/model').IssueWire | null>(null)
  const trpc = store.trpc
  // Scroll-back paging state. Refs, not state: paging must not retrigger the
  // load/subscribe effect, and onEndReached can fire in bursts.
  const paging = useRef<{ head?: string; hasMore: boolean; loading: boolean }>({
    hasMore: false,
    loading: false,
  })

  useEffect(() => {
    if (!sessionId) return
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
    if (!sessionId || items.length === 0) return
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
      if (!sessionId) return
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
    if (!sessionId || !p.hasMore || p.loading || !p.head) return
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

  // Round-robin triage order: needsYou, then idle, then working. Derived HERE
  // rather than published: this screen is its only consumer, and a slice with
  // one reader is the god object growing back under a nicer name (POD-409's
  // rule 1, applied in the direction that says NO).
  const focusSessionIds = useMemo(() => {
    const groups = groupSessions(withoutShells(allSessions))
    return [...groups.needsYou, ...groups.idle, ...groups.working].map((s) => s.sessionId)
  }, [allSessions])

  const nextSession = useCallback(() => {
    if (!sessionId) return
    if (focusSessionIds.length === 0) return
    const at = focusSessionIds.indexOf(sessionId)
    const next = focusSessionIds[(at + 1) % focusSessionIds.length]
    if (next && next !== sessionId) router.replace(sessionHref(next, backTarget))
  }, [backTarget, focusSessionIds, router, sessionId])

  const title = session ? sessionTitle(session) : 'Session'
  const issue = useIssue(session?.issueId)
  // A peek stores the selected identity, but renders the replica's live row so
  // a todo toggle updates in the still-open sheet instead of waiting for reopen.
  const livePeekIssue = peekIssue
    ? (issues.find((candidate) => candidate.id === peekIssue.id) ?? peekIssue)
    : null
  const offerArtifacts = useMemo(
    () =>
      session?.offer
        ? resolveOfferArtifacts({
            offer: session.offer,
            issue,
            ...(session.lastInputAt ? { lastInputAt: session.lastInputAt } : {}),
          })
        : [],
    [issue, session],
  )
  // The issue colour flows through the chrome; slate when the issue is uncoloured.
  const accent = issue ? (issueColorHex(issue.color) ?? FLOW_SLATE) : undefined

  const menuActions = useMemo<SheetAction[]>(() => {
    if (!session) return []
    const actions: SheetAction[] = [
      {
        label: 'Next session',
        hint: 'Jump to the next one waiting on you',
        onPress: nextSession,
      },
      {
        label: session.archived ? 'Unarchive' : 'Archive',
        onPress: () => void store.archiveSession(session.sessionId, !session.archived),
      },
      { label: 'Set work state…', onPress: () => setWorkMenuOpen(true) },
      {
        label: 'Snooze until next message',
        onPress: () => void store.setSnooze(session.sessionId, null),
      },
      {
        label: 'Snooze for 1 hour',
        onPress: () => void store.setSnooze(session.sessionId, snoozeUntil1h(Date.now())),
      },
      {
        label: 'Snooze until tomorrow',
        onPress: () => void store.setSnooze(session.sessionId, snoozeUntilTomorrow5am(Date.now())),
      },
    ]
    if (session.snoozedUntil !== undefined) {
      actions.push({
        label: 'Clear snooze',
        onPress: () => void store.clearSnooze(session.sessionId),
      })
    }
    if (session.agentState?.phase === 'errored') {
      actions.push({
        label: 'Continue after error',
        onPress: () => void store.continueSession(session.sessionId),
      })
    }
    if (
      session.status === 'live' ||
      session.status === 'starting' ||
      session.status === 'reconnecting'
    ) {
      actions.push({
        label: 'Kill session',
        destructive: true,
        onPress: () => void store.killSession(session.sessionId),
      })
    }
    return actions
  }, [nextSession, store, session])

  if (!sessionId || !session) {
    // A SESSION THAT IS NOT HERE IS THREE DIFFERENT FACTS (doc §3.1 ¶2).
    // Deleted, evicted from THIS principal's view (a share revoked, or never
    // granted — it still exists), or simply not arrived yet. This screen used to
    // render all three as "it may have been removed on the server", which is the
    // exact defect `resolveReferent` exists to prevent: an eviction rendered as
    // a deletion. `pending` says "not yet" without spinning forever, and every
    // state is terminal copy rather than a loader.
    const absence = sessionAbsence(sessionId, session, (id) =>
      store.replica.exitKind?.('session', id),
    )
    return (
      <Screen title="Session" onBack={goBack} safeBottom>
        <BootstrapCrossfade resolved={!booting} placeholder={<DetailSkeleton />}>
          <EmptyState title={absence.title} body={absence.body} />
        </BootstrapCrossfade>
      </Screen>
    )
  }
  const activity = chatActivity(session, false)
  const issueTodos = issue?.panel?.todos ?? []
  const todoProgress = issueTodos.length
    ? { done: issueTodos.filter((todo) => todo.done).length, total: issueTodos.length }
    : undefined

  return (
    <Screen
      title={title}
      subtitle={
        session
          ? `${panelLabel(session.agentKind)} · ${agentBadge(session)?.label ?? session.status}${session.queuedMessageCount ? ` · ${session.queuedMessageCount} queued` : ''}`
          : undefined
      }
      onBack={goBack}
      backLabel="Back"
      accent={accent}
      safeBottom
      leading={
        issue ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Task POD-${issue.seq} — peek`}
            onPress={() => issue && setPeekIssue(issue)}
            hitSlop={8}
          >
            <IdSquare
              issue={issue}
              state={
                issue.needsHuman || sessionDotTone(session) === 'attention' ? 'waiting' : 'working'
              }
              size={18}
            />
          </PressableScale>
        ) : undefined
      }
      right={
        <>
          <HeaderButton
            label="Open terminal"
            onPress={() => router.push(`/session/${encodeURIComponent(sessionId)}/terminal`)}
          >
            <Icon as={SquareTerminal} size={17} color={color.textDim} />
          </HeaderButton>
          <HeaderButton label="Session actions" onPress={() => setMenuOpen(true)}>
            <Icon as={MoreVertical} size={17} color={color.textDim} />
          </HeaderButton>
        </>
      }
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <BootstrapCrossfade
          resolved={loaded || items.length > 0}
          placeholder={<TranscriptSkeleton />}
        >
          <PullToRefreshBoundary connected={connected} refreshing={refreshing} onRefresh={onRefresh}>
            <TranscriptList
              items={items}
              live={session?.status === 'live'}
              assetContext={{
                httpOrigin: store.httpOrigin,
                sessionId,
                cwd: session.cwd,
              }}
              pendingTurns={pendingTurns}
              onRetryPending={retry}
              onQuote={(text) => setDraftInsertion({ id: insertionSeq.current++, text })}
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
                  activity?.label ?? (session.agentState?.phase === 'idle' ? 'Idle' : session.status),
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
              onAnswer={async (choices) => {
                await trpc.sessions.answerAskUserQuestion.mutate({ sessionId, choices })
              }}
              onLoadOlder={loadOlder}
              onRefPress={(ref) => {
                const seq = Number(ref.slice(4))
                const target = issues.find((i) => i.seq === seq)
                if (target) setPeekIssue(target)
              }}
              footer={
                session.offer ? (
                  <SessionActionCard
                    offer={session.offer}
                    evidenceCount={offerArtifacts.length}
                    onAction={(prompt) => store.resumeAndSend(session.sessionId, prompt)}
                    onOpenEvidence={
                      issue ? () => router.push(`/issue/${encodeURIComponent(issue.id)}`) : undefined
                    }
                  />
                ) : undefined
              }
            />
          </PullToRefreshBoundary>
        </BootstrapCrossfade>
        <Composer placeholder="Message the agent…" onSend={send} draftInsertion={draftInsertion} />
      </KeyboardAvoidingView>
      <TaskPeekSheet
        issue={livePeekIssue}
        session={session}
        sessions={allSessions}
        onClose={() => setPeekIssue(null)}
        onToggleTodo={(index, done) => {
          if (!livePeekIssue) return
          void trpc.issues.panelApply.mutate({
            id: livePeekIssue.id,
            op: done ? 'todo-done' : 'todo-undone',
            index,
          })
        }}
      />
      <ActionSheet
        visible={menuOpen}
        title={title}
        actions={menuActions}
        onClose={() => setMenuOpen(false)}
      />
      <ActionSheet
        visible={workMenuOpen}
        title="Work state"
        actions={WORK_STATES.map((ws) => ({
          label: ws ? ws[0].toUpperCase() + ws.slice(1) : 'Unsorted',
          onPress: () => void store.setWorkState(sessionId, ws),
        }))}
        onClose={() => setWorkMenuOpen(false)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
})
