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
import type { TranscriptItem, WorkState } from '@podium/protocol'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { MoreVertical } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { IdSquare } from '../components/IdSquare'
import { HeaderButton, Screen } from '../components/Screen'
import { TaskPeekSheet } from '../components/TaskPeekSheet'
import { TranscriptList } from '../components/TranscriptList'
import { TrayCard, type TrayCardActions } from '../components/TrayCard'
import { EmptyState } from '../components/ui'
import { TerminalPane } from '../terminal/TerminalPane'
import { FLOW_SLATE, issueColorHex } from '../theme/issueColors'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

const WORK_STATES: (WorkState | null)[] = [
  'planning',
  'implementing',
  'testing',
  'done',
  'icebox',
  null,
]

export function SessionScreen() {
  const params = useLocalSearchParams<{ sessionId: string | string[] }>()
  const sessionId = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId
  const router = useRouter()
  const client = useMobileClient()
  const session = sessionId ? client.sessionById(sessionId) : undefined

  const [items, setItems] = useState<TranscriptItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [workMenuOpen, setWorkMenuOpen] = useState(false)
  // Chat is the default view; 'native' flips to the real PTY in place [POD-131].
  const [view, setView] = useState<'chat' | 'native'>('chat')
  const [peekIssue, setPeekIssue] = useState<import('@podium/protocol').IssueWire | null>(null)
  const { readTranscript, subscribeTranscript } = client
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
    paging.current = { hasMore: false, loading: false }
    const attach = (since: string | undefined) => {
      if (!alive) return
      unsubscribe = subscribeTranscript(sessionId, since, (delta, meta) => {
        setItems((prev) => (meta.reset ? delta : mergeTranscriptItems(prev, delta)))
      })
    }
    readTranscript(sessionId)
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
  }, [readTranscript, subscribeTranscript, sessionId])

  const loadOlder = useCallback(() => {
    const p = paging.current
    if (!sessionId || !p.hasMore || p.loading || !p.head) return
    p.loading = true
    readTranscript(sessionId, p.head)
      .then((page) => {
        paging.current = { head: page.head, hasMore: page.hasMore, loading: false }
        setItems((prev) => prependTranscriptItems(prev, page.items))
      })
      .catch(() => {
        paging.current.loading = false
      })
  }, [readTranscript, sessionId])

  const nextSession = useCallback(() => {
    if (!sessionId) return
    const ids = client.focusSessionIds
    if (ids.length === 0) return
    const at = ids.indexOf(sessionId)
    const next = ids[(at + 1) % ids.length]
    if (next && next !== sessionId) router.replace(`/session/${next}`)
  }, [client.focusSessionIds, router, sessionId])

  const title = session ? sessionTitle(session) : 'Session'
  const issue = session?.issueId ? client.issueById(session.issueId) : undefined
  // The issue colour flows through the chrome; slate when the issue is uncoloured.
  const accent = issue ? (issueColorHex(issue.color) ?? FLOW_SLATE) : undefined

  const menuActions = useMemo<SheetAction[]>(() => {
    if (!session) return []
    const actions: SheetAction[] = [
      {
        label: session.archived ? 'Unarchive' : 'Archive',
        onPress: () => void client.setArchived(session.sessionId, !session.archived),
      },
      { label: 'Set work state…', onPress: () => setWorkMenuOpen(true) },
      {
        label: 'Snooze until next message',
        onPress: () => void client.snooze(session.sessionId, null),
      },
      {
        label: 'Snooze for 1 hour',
        onPress: () => void client.snooze(session.sessionId, snoozeUntil1h(Date.now())),
      },
      {
        label: 'Snooze until tomorrow',
        onPress: () => void client.snooze(session.sessionId, snoozeUntilTomorrow5am(Date.now())),
      },
    ]
    if (session.snoozedUntil !== undefined) {
      actions.push({
        label: 'Clear snooze',
        onPress: () => void client.clearSnooze(session.sessionId),
      })
    }
    if (session.agentState?.phase === 'errored') {
      actions.push({
        label: 'Continue after error',
        onPress: () => void client.continueSession(session.sessionId),
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
        onPress: () => void client.killSession(session.sessionId),
      })
    }
    return actions
  }, [client, session])

  const offerActions: TrayCardActions = {
    onOfferAction: (target, prompt) => void client.sendMessage(target.sessionId, prompt),
    onOpenSession: () => {},
    onOpenIssue: (target) => router.push(`/issue/${encodeURIComponent(target.id)}`),
    onResolve: (target) => void client.trpc.issues.clearNeedsHuman.mutate({ id: target.id }),
    onArchive: (target) => void client.trpc.issues.archive.mutate({ id: target.id }),
    onOpenArtifact: (target) => router.push(`/issue/${encodeURIComponent(target.id)}`),
  }

  if (!sessionId || !session) {
    return (
      <Screen title="Session" onBack={() => router.back()}>
        <EmptyState
          title="Session not found."
          body={
            client.connected
              ? 'It may have been removed on the server.'
              : 'Still connecting — it may appear in a moment.'
          }
        />
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
                    mono(600),
                    styles.segmentText,
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
        ) : loaded && items.length === 0 ? (
          <EmptyState title="No transcript yet" body="Send a message to get things moving." />
        ) : (
          <TranscriptList
            items={items}
            live={session?.status === 'live'}
            onAnswer={(choices) => client.answerQuestion(sessionId, choices)}
            onLoadOlder={loadOlder}
            onRefPress={(ref) => {
              const seq = Number(ref.slice(4))
              const target = client.issues.find((i) => i.seq === seq)
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
              issues={client.issues}
              httpOrigin={client.serverConfig.httpOrigin}
              actions={offerActions}
              now={Date.now()}
            />
          </View>
        ) : null}
        {view === 'chat' ? (
          <Composer
            placeholder="Message the agent…"
            onSend={(text) => void client.sendMessage(sessionId, text)}
          />
        ) : null}
      </KeyboardAvoidingView>
      <TaskPeekSheet issue={peekIssue} session={session} onClose={() => setPeekIssue(null)} />
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
          onPress: () => void client.setWorkState(sessionId, ws),
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
  segmentTextNative: {
    color: color.accent,
  },
  terminalWrap: {
    flex: 1,
    backgroundColor: color.bgSunken,
  },
  offerWrap: {
    paddingHorizontal: space.sm + 2,
    paddingBottom: space.xs,
  },
})
