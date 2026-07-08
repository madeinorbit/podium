import type { TranscriptItem, WorkState } from '@podium/protocol'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { MoreVertical, SquareTerminal } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { HeaderButton, Screen } from '../components/Screen'
import { TranscriptList } from '../components/TranscriptList'
import { EmptyState } from '../components/ui'
import { color, font } from '../theme/theme'
import { sessionTitle } from '../viewModels/sessionCard'
import { mergeTranscriptItems, prependTranscriptItems } from '../viewModels/transcript'

const WORK_STATES: (WorkState | null)[] = [
  'planning',
  'implementing',
  'testing',
  'done',
  'icebox',
  null,
]

function phaseLabel(phase: string | undefined, status: string): string {
  switch (phase) {
    case 'needs_user':
      return 'needs you'
    case 'working':
    case 'errored':
    case 'idle':
    case 'compacting':
      return phase
    default:
      return status
  }
}

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
          ? `${session.agentKind} · ${phaseLabel(session.agentState?.phase, session.status)}${session.queuedMessageCount ? ` · ${session.queuedMessageCount} queued` : ''}`
          : undefined
      }
      onBack={() => router.back()}
      backLabel="Back"
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
            <HeaderButton
              label="Open terminal"
              onPress={() => router.push(`/session/${sessionId}/terminal`)}
            >
              <Icon as={SquareTerminal} size={17} color={color.textDim} />
            </HeaderButton>
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
        {loaded && items.length === 0 ? (
          <EmptyState title="No transcript yet" body="Send a message to get things moving." />
        ) : (
          <TranscriptList
            items={items}
            live={session?.status === 'live'}
            onAnswer={(choices) => client.answerQuestion(sessionId, choices)}
            onLoadOlder={loadOlder}
          />
        )}
        <Composer
          placeholder="Message the agent…"
          onSend={(text) => void client.sendMessage(sessionId, text)}
        />
      </KeyboardAvoidingView>
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
  nextText: {
    color: color.accent,
    fontSize: font.body,
    fontWeight: '600',
  },
})
