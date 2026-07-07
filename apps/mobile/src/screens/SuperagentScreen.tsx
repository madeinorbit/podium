import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import type { SuperagentMessage, SuperagentThread } from '../client/trpc'
import { Composer } from '../components/Composer'
import { Screen } from '../components/Screen'
import { EmptyState } from '../components/ui'
import { color, font, radius, space } from '../theme/theme'

function threadLabel(thread: SuperagentThread): string {
  if (thread.id === 'global') return 'Global'
  if (thread.title?.trim()) return thread.title.trim()
  if (thread.kind === 'concierge' && thread.repoPath) {
    return thread.repoPath.split('/').filter(Boolean).pop() ?? thread.id
  }
  return thread.id
}

/**
 * Delegation desk: chat with the headless orchestrator. The global thread is
 * always there; btw/concierge threads show as chips. Live turn output streams
 * in via the thread's headless session; history is the durable record.
 */
export function SuperagentScreen() {
  const client = useMobileClient()
  const { trpc, subscribeHeadless } = client
  const [threads, setThreads] = useState<SuperagentThread[]>([])
  const [threadId, setThreadId] = useState('global')
  const [history, setHistory] = useState<SuperagentMessage[]>([])
  const [liveText, setLiveText] = useState('')
  const [statusLabel, setStatusLabel] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [podiumSid, setPodiumSid] = useState<string | undefined>(undefined)

  const refreshThreads = useCallback(async () => {
    try {
      const list = await trpc.superagent.listThreads.query()
      setThreads(list.filter((t) => !t.archived))
    } catch {
      // metadata-only failure; the global thread still works
    }
  }, [trpc])

  const refreshHistory = useCallback(async () => {
    try {
      const rows = await trpc.superagent.history.query({ threadId })
      setHistory(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [trpc, threadId])

  useEffect(() => {
    void refreshThreads()
  }, [refreshThreads])

  useEffect(() => {
    setHistory([])
    setLiveText('')
    setStatusLabel(null)
    setError(null)
    void refreshHistory()
    setPodiumSid(threads.find((t) => t.id === threadId)?.podiumSessionId)
  }, [refreshHistory, threadId, threads])

  // Live turn activity: stream the assistant's in-progress text and refresh the
  // durable history at turn boundaries.
  useEffect(() => {
    if (!podiumSid) return
    return subscribeHeadless(podiumSid, (event) => {
      if (event.kind === 'turn-start') {
        setRunning(true)
        setLiveText('')
        setStatusLabel('starting')
      } else if (event.kind === 'turn-end') {
        setRunning(false)
        setLiveText('')
        setStatusLabel(null)
        if (event.error) setError(event.error)
        void refreshHistory()
      } else if (event.kind === 'status') {
        setStatusLabel(event.status === 'tool' ? (event.label ?? 'tool') : event.status)
      } else if ('text' in event && typeof event.text === 'string') {
        setLiveText(event.text)
        setStatusLabel(null)
      }
    })
  }, [subscribeHeadless, refreshHistory, podiumSid])

  // Fallback while a turn runs without streaming events (older daemons): poll.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => void refreshHistory(), 3000)
    return () => clearInterval(id)
  }, [running, refreshHistory])

  const send = useCallback(
    async (text: string) => {
      setError(null)
      setRunning(true)
      setHistory((prev) => [
        ...prev,
        { id: -Date.now(), role: 'user', content: text, createdAt: new Date().toISOString() },
      ])
      try {
        const ack = await trpc.superagent.sendTurn.mutate({ threadId, text })
        if (ack?.podiumSessionId) setPodiumSid(ack.podiumSessionId)
        void refreshThreads()
      } catch (e) {
        setRunning(false)
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [trpc, threadId, refreshThreads],
  )

  const interrupt = useCallback(async () => {
    try {
      await trpc.superagent.interruptTurn.mutate({ threadId })
      setRunning(false)
    } catch {
      // already stopped
    }
  }, [trpc, threadId])

  const visible = useMemo(
    () => history.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim()),
    [history],
  )
  const data = useMemo(() => [...visible].reverse(), [visible])

  return (
    <Screen
      title="Superagent"
      subtitle="delegate work, steer sessions"
      right={
        running ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop turn"
            onPress={() => void interrupt()}
            hitSlop={8}
          >
            <Text style={styles.stop}>Stop</Text>
          </Pressable>
        ) : undefined
      }
    >
      {threads.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chips}
          contentContainerStyle={styles.chipsContent}
        >
          {[{ id: 'global' } as SuperagentThread, ...threads.filter((t) => t.id !== 'global')].map(
            (t) => (
              <Pressable
                key={t.id}
                accessibilityRole="button"
                accessibilityLabel={`Thread ${threadLabel(t)}`}
                onPress={() => setThreadId(t.id)}
                style={[styles.chip, threadId === t.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, threadId === t.id && styles.chipTextActive]}>
                  {threadLabel(t)}
                </Text>
              </Pressable>
            ),
          )}
        </ScrollView>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        inverted
        data={data}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          running ? (
            <View style={styles.liveRow}>
              {liveText ? (
                <View style={[styles.bubble, styles.assistantBubble]}>
                  <Text style={styles.bubbleText}>{liveText}</Text>
                </View>
              ) : (
                <Text style={styles.status}>{statusLabel ? `⋯ ${statusLabel}` : '⋯ thinking'}</Text>
              )}
            </View>
          ) : null
        }
        renderItem={({ item: m }) => (
          <View style={[styles.row, m.role === 'user' && styles.userAlign]}>
            <View
              style={[
                styles.bubble,
                m.role === 'user' ? styles.userBubble : styles.assistantBubble,
              ]}
            >
              <Text style={styles.bubbleText} selectable>
                {m.content.trim()}
              </Text>
            </View>
          </View>
        )}
        ListEmptyComponent={
          !running ? (
            <View style={styles.emptyFlip}>
              <EmptyState
                title="Hand off some work"
                body="The superagent can read your repos, file issues, spawn worker sessions and steer them — describe what you want done."
              />
            </View>
          ) : null
        }
      />
      <Composer placeholder="Delegate a task…" onSend={(text) => void send(text)} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  chips: {
    flexGrow: 0,
  },
  chipsContent: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  chip: {
    borderRadius: radius.full,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    backgroundColor: color.card,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipActive: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  chipText: {
    color: color.textDim,
    fontSize: font.small,
    fontWeight: '600',
  },
  chipTextActive: {
    color: color.accentText,
  },
  listContent: {
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    flexGrow: 1,
  },
  row: {
    marginBottom: space.sm,
  },
  userAlign: {
    alignItems: 'flex-end',
  },
  liveRow: {
    marginBottom: space.sm,
  },
  bubble: {
    maxWidth: '92%',
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  userBubble: {
    backgroundColor: color.userBubble,
    alignSelf: 'flex-end',
  },
  assistantBubble: {
    backgroundColor: color.assistantBubble,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
  bubbleText: {
    color: color.text,
    fontSize: font.body,
    lineHeight: 21,
  },
  status: {
    color: color.textFaint,
    fontSize: font.small,
    fontStyle: 'italic',
    paddingHorizontal: space.sm,
  },
  stop: {
    color: color.danger,
    fontSize: font.body,
    fontWeight: '700',
  },
  error: {
    color: color.danger,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingBottom: space.xs,
  },
  emptyFlip: {
    transform: [{ scaleY: -1 }],
  },
})
