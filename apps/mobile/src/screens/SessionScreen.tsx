import { groupSessions, withoutShells } from '@podium/client-core/focus'
import {
  agentBadge,
  chatActivity,
  mergeTranscriptItems,
  panelLabel,
  prependTranscriptItems,
  sessionTitle,
  snoozeUntil1h,
  snoozeUntilTomorrow5am,
} from '@podium/client-core/viewmodels'
import type { TranscriptItem, WorkState } from '@podium/model'
import { asSessionId } from '@podium/model'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { MoreVertical } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import {
  readTranscriptPage,
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
import { HeaderButton, Screen } from '../components/Screen'
import { TaskPeekSheet } from '../components/TaskPeekSheet'
import { type PendingTurn, TranscriptList } from '../components/TranscriptList'
import { TrayCard, type TrayCardActions } from '../components/TrayCard'
import { EmptyState } from '../components/ui'
import { TerminalPane } from '../terminal/TerminalPane'
import { FLOW_SLATE, issueColorHex } from '../theme/issueColors'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'
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
  const params = useLocalSearchParams<{ sessionId: string | string[] }>()
  const rawSessionId = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId
  const sessionId = rawSessionId ? asSessionId(rawSessionId) : undefined
  const router = useRouter()
  const store = useMobileStore()
  const hub = useHub()
  const allSessions = useSessions()
  const issues = useIssues()
  const session = useSession(sessionId)

  const [items, setItems] = useState<TranscriptItem[]>([])
  const [loaded, setLoaded] = useState(false)
  // Turns sent from this screen, painted until the server echoes them into the
  // transcript (POD-338). A parked session queues the message and answers
  // minutes later — without this the composer reads as if it never sent.
  const [pendingTurns, setPendingTurns] = useState<PendingTurn[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [workMenuOpen, setWorkMenuOpen] = useState(false)
  // Chat is the default view; 'native' flips to the real PTY in place [POD-131].
  const [view, setView] = useState<'chat' | 'native'>('chat')
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
    setItems([])
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
  }, [trpc, hub, sessionId])

  useEffect(() => {
    if (pendingTurns.length === 0) return
    const echoed = new Set(items.filter((i) => i.role === 'user').map((i) => i.text.trim()))
    setPendingTurns((prev) => {
      const next = prev.filter((turn) => !echoed.has(turn.text.trim()))
      return next.length === prev.length ? prev : next
    })
  }, [items, pendingTurns.length])

  const send = useCallback(
    (text: string) => {
      if (!sessionId) return
      const trimmed = text.trim()
      if (!trimmed) return
      setPendingTurns((prev) => [...prev, { id: `${Date.now()}:${prev.length}`, text: trimmed }])
      void store.resumeAndSend(sessionId, trimmed)
    },
    [store.resumeAndSend, sessionId],
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
    if (next && next !== sessionId) router.replace(`/session/${next}`)
  }, [focusSessionIds, router, sessionId])

  const title = session ? sessionTitle(session) : 'Session'
  const issue = useIssue(session?.issueId)
  // The issue colour flows through the chrome; slate when the issue is uncoloured.
  const accent = issue ? (issueColorHex(issue.color) ?? FLOW_SLATE) : undefined

  const menuActions = useMemo<SheetAction[]>(() => {
    if (!session) return []
    const actions: SheetAction[] = [
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
  }, [store, session])

  const offerActions: TrayCardActions = {
    onOfferAction: (target, prompt) => void store.resumeAndSend(target.sessionId, prompt),
    onOpenSession: () => {},
    onOpenIssue: (target) => router.push(`/issue/${encodeURIComponent(target.id)}`),
    onResolve: (target) => void store.trpc.issues.clearNeedsHuman.mutate({ id: target.id }),
    onOpenArtifact: (target) => router.push(`/issue/${encodeURIComponent(target.id)}`),
  }

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
      <Screen title="Session" onBack={() => router.back()}>
        <EmptyState title={absence.title} body={absence.body} />
      </Screen>
    )
  }

  return (
    <Screen
      title={title}
      subtitle={
        session
          ? `${panelLabel(session.agentKind)} · ${agentBadge(session)?.label ?? session.status}${session.queuedMessageCount ? ` · ${session.queuedMessageCount} queued` : ''}`
          : undefined
      }
      onBack={() => router.back()}
      backLabel="Back"
      accent={accent}
      leading={
        issue ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Task POD-${issue.seq} — peek`}
            onPress={() => issue && setPeekIssue(issue)}
            hitSlop={8}
          >
            <IdSquare issue={issue} state="working" size={18} />
          </Pressable>
        ) : undefined
      }
      right={
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next session"
            onPress={nextSession}
            hitSlop={8}
          >
            <Text style={styles.nextText}>Next</Text>
          </Pressable>
          {Platform.OS === 'web' ? (
            <View style={styles.segment}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Chat view"
                accessibilityState={view === 'chat' ? { selected: true } : {}}
                onPress={() => setView('chat')}
                style={[styles.segmentCell, view === 'chat' && styles.segmentCellActive]}
              >
                <Text style={[styles.segmentText, view === 'chat' && styles.segmentTextActive]}>
                  Chat
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Native agent view"
                accessibilityState={view === 'native' ? { selected: true } : {}}
                onPress={() => setView('native')}
                style={[styles.segmentCell, view === 'native' && styles.segmentCellActive]}
              >
                <Text
                  style={[
                    styles.segmentText,
                    styles.segmentTextTerminal,
                    view === 'native' && styles.segmentTextNative,
                  ]}
                >
                  {'>_'}
                </Text>
              </Pressable>
            </View>
          ) : null}
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
        {view === 'native' ? (
          <View style={styles.terminalWrap}>
            <TerminalPane sessionId={sessionId} />
          </View>
        ) : loaded && items.length === 0 && pendingTurns.length === 0 ? (
          <EmptyState fill title="No transcript yet" body="Send a message to get things moving." />
        ) : (
          <TranscriptList
            items={items}
            live={session?.status === 'live'}
            pendingTurns={pendingTurns}
            onAnswer={async (choices) => {
              await trpc.sessions.answerAskUserQuestion.mutate({ sessionId, choices })
            }}
            onLoadOlder={loadOlder}
            onRefPress={(ref) => {
              const seq = Number(ref.slice(4))
              const target = issues.find((i) => i.seq === seq)
              if (target) setPeekIssue(target)
            }}
          />
        )}
        {(() => {
          const activity = chatActivity(session, false)
          if (!activity) return null
          return (
            <Text
              style={[styles.activity, activity.tone === 'attention' && styles.activityAttention]}
            >
              {activity.label}
            </Text>
          )
        })()}
        {view === 'chat' && session.offer && issue ? (
          <View style={styles.offerWrap}>
            <TrayCard
              item={{
                kind: 'offer',
                issue,
                session,
                offer: session.offer,
                since: session.offer.createdAt,
              }}
              issues={issues}
              sessions={allSessions}
              httpOrigin={store.httpOrigin}
              actions={offerActions}
              now={Date.now()}
            />
          </View>
        ) : null}
        {view === 'chat' ? <Composer placeholder="Message the agent…" onSend={send} /> : null}
      </KeyboardAvoidingView>
      <TaskPeekSheet
        issue={peekIssue}
        session={session}
        sessions={allSessions}
        onClose={() => setPeekIssue(null)}
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
  activity: {
    ...monoLabel(9),
    color: color.working,
    paddingHorizontal: space.lg,
    paddingBottom: space.xs,
  },
  activityAttention: {
    color: color.needsYou,
  },
  nextText: {
    ...sans(600),
    color: color.accent,
    fontSize: font.small,
  },
  segment: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
    overflow: 'hidden',
    height: 28,
  },
  segmentCell: {
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentCellActive: {
    backgroundColor: color.elevated,
  },
  segmentText: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.tiny + 0.5,
  },
  segmentTextActive: {
    color: color.text,
  },
  /**
   * The `>_` terminal mark (POD-355). Two things kept it from lining up with
   * the "Chat" label beside it:
   *  - it asked for `mono(600)` FIRST in the style array, so `segmentText`'s
   *    `sans(600)` silently won (later styles override earlier ones) and the
   *    terminal mark rendered in the proportional face;
   *  - the cell centres each label's LINE BOX, but `>_` has no ascender and its
   *    underscore sits below the baseline, so its ink lands ~1.5px lower than a
   *    cap-height word in the same box. Lift it back onto Chat's optical centre
   *    with a transform, which nudges the glyph without reflowing the 28px strip.
   */
  segmentTextTerminal: {
    ...mono(600),
    transform: [{ translateY: -1.5 }],
  },
  segmentTextNative: {
    color: color.accent,
  },
  terminalWrap: {
    flex: 1,
    // minHeight 0 is what keeps the native pane INSIDE the viewport: without it
    // the terminal's flex child can only grow, and a tall agent frame pushes the
    // pane past the bottom of the screen (POD-338).
    minHeight: 0,
    overflow: 'hidden',
    backgroundColor: color.bgSunken,
  },
  offerWrap: {
    paddingHorizontal: space.sm + 2,
    paddingBottom: space.xs,
  },
})
