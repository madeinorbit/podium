import { LinearGradient } from 'expo-linear-gradient'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import type { SuperagentMessage, SuperagentThread } from '../client/trpc'
import { Composer } from '../components/Composer'
import { Screen } from '../components/Screen'
import { BrailleSpinner } from '../components/StatusGlyphs'
import { EmptyState } from '../components/ui'
import { FLOW_SLATE } from '../theme/issueColors'
import { alpha, mix } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

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
    <Screen noHeader>
      {/* Engraved canvas: slate context glow fading into #0a0a0e (colour-flow §2.4). */}
      <View style={styles.engraved}>
        <LinearGradient
          colors={[mix(FLOW_SLATE, 9, color.engraved), color.engraved]}
          style={styles.glow}
          pointerEvents="none"
        />
        {/* Super-agent section bar — the compact #08080c bar grammar. */}
        <View style={styles.saBar}>
          <Text style={styles.saGlyph}>✦</Text>
          <Text style={styles.saTitle}>Super agent</Text>
          <Text style={styles.saScope}>OVERARCHING</Text>
          {running ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop turn"
              onPress={() => void interrupt()}
              hitSlop={8}
              style={styles.stopWrap}
            >
              <Text style={styles.stop}>Stop</Text>
            </Pressable>
          ) : null}
        </View>
        {threads.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chips}
            contentContainerStyle={styles.chipsContent}
          >
            {[
              { id: 'global' } as SuperagentThread,
              ...threads.filter((t) => t.id !== 'global'),
            ].map((t) => (
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
            ))}
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
                  <View style={[styles.block, styles.agentBlock]}>
                    <Text style={styles.roleLabel}>SUPER AGENT</Text>
                    <Text style={styles.blockText}>{liveText}</Text>
                  </View>
                ) : (
                  <View style={styles.statusRow}>
                    <BrailleSpinner size={11} />
                    <Text style={styles.status}>{statusLabel ?? 'thinking'}</Text>
                  </View>
                )}
              </View>
            ) : null
          }
          renderItem={({ item: m }) => (
            <View style={[styles.block, m.role === 'user' ? styles.youBlock : styles.agentBlock]}>
              <Text style={[styles.roleLabel, m.role === 'user' && styles.youLabel]}>
                {m.role === 'user' ? 'YOU' : 'SUPER AGENT'}
              </Text>
              <Text style={styles.blockText} selectable>
                {m.content.trim()}
              </Text>
            </View>
          )}
          ListEmptyComponent={
            !running ? (
              <View style={styles.emptyFlip}>
                <EmptyState
                  title="Hand off some work"
                  body="The superagent can read your repos, file tasks, spawn worker sessions and steer them — describe what you want done."
                />
              </View>
            ) : null
          }
        />
        <View style={styles.composerLift}>
          <Composer placeholder="Delegate a task…" onSend={(text) => void send(text)} />
        </View>
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  engraved: {
    flex: 1,
    backgroundColor: color.engraved,
  },
  glow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 220,
  },
  saBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: color.bar,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairlineBar,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  saGlyph: {
    color: color.accent,
    fontSize: 12,
  },
  saTitle: {
    ...sans(600),
    color: color.text,
    fontSize: font.small,
  },
  saScope: {
    ...monoLabel(8),
    color: color.textMicro,
  },
  stopWrap: {
    marginLeft: 'auto',
  },
  composerLift: {
    paddingBottom: 86,
  },
  chips: {
    flexGrow: 0,
  },
  chipsContent: {
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  chip: {
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    backgroundColor: color.surface,
    borderColor: color.hairlineBar,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipActive: {
    backgroundColor: color.accentSoft,
    borderColor: color.accentBorder,
  },
  chipText: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.tiny + 1,
  },
  chipTextActive: {
    color: color.accent,
  },
  listContent: {
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    flexGrow: 1,
  },
  liveRow: {
    marginBottom: space.sm,
  },
  // Chat feed grammar: role blocks with a 3px left rule — blue = you,
  // green = the agent (engraved-column spec).
  block: {
    borderLeftWidth: 3,
    paddingLeft: 10,
    paddingVertical: 2,
    marginBottom: space.md,
    gap: 3,
  },
  youBlock: {
    borderLeftColor: alpha(color.info, 0.75),
  },
  agentBlock: {
    borderLeftColor: alpha(color.working, 0.75),
  },
  roleLabel: {
    ...sans(600),
    color: color.working,
    fontSize: font.micro,
    letterSpacing: 0.63,
  },
  youLabel: {
    color: color.info,
  },
  blockText: {
    ...sans(400),
    color: color.body,
    fontSize: font.body,
    lineHeight: 19,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 13,
  },
  status: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.tiny,
  },
  stop: {
    ...sans(700),
    color: color.danger,
    fontSize: font.small,
  },
  error: {
    ...sans(400),
    color: color.danger,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingBottom: space.xs,
  },
  emptyFlip: {
    transform: [{ scaleY: -1 }],
  },
})
