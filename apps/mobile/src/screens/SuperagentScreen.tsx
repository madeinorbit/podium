import type { TranscriptItem } from '@podium/protocol'
import { Eraser } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileClient } from '../client/MobileClientProvider'
import type { SuperagentMessage } from '../client/trpc'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { Screen } from '../components/Screen'
import { BrailleSpinner } from '../components/StatusGlyphs'
import { type PendingTurn, TranscriptList } from '../components/TranscriptList'
import { EmptyState } from '../components/ui'
import { color, font, mono, monoLabel, sans, space } from '../theme/theme'

/**
 * The Super agent — the phone half of the engraved column's overarching chat
 * [POD-338]. It is the desktop surface, not a variant of it:
 *
 *  - ONE thread, always `global` (desktop `THREAD_ID`). The old global/btw chip
 *    strip is gone: per-thread history is not a phone decision, and the scope
 *    label already says the chat is overarching.
 *  - The SAME Flat Field transcript the session chat renders (the desktop
 *    embeds `ChatView` here for exactly this reason) instead of a second,
 *    bespoke chat vocabulary.
 *  - Laid out like every other tab: safe-area header, one scroller, composer
 *    docked directly above the tab bar — no hand-tuned lift leaving dead space.
 */
const THREAD_ID = 'global'

/** Superagent history rows → the transcript items the Flat Field renderer
 *  speaks. Tool/system rows collapse to quiet lines, exactly as in a session. */
function toTranscript(rows: SuperagentMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  for (const row of rows) {
    const text = row.content.trim()
    if (row.role === 'tool') {
      if (!row.toolName && !text) continue
      items.push({
        id: `super:${row.id}`,
        role: 'tool',
        ts: row.createdAt,
        text: '',
        ...(row.toolName ? { toolName: row.toolName } : {}),
        ...(text ? { toolInput: text.split('\n')[0] } : {}),
      })
      continue
    }
    if (!text) continue
    items.push({
      id: `super:${row.id}`,
      role: row.role === 'user' ? 'user' : row.role === 'system' ? 'system' : 'assistant',
      ts: row.createdAt,
      text,
    })
  }
  return items
}

export function SuperagentScreen() {
  const client = useMobileClient()
  const { trpc, subscribeHeadless } = client
  const insets = useSafeAreaInsets()
  const [history, setHistory] = useState<SuperagentMessage[]>([])
  const [liveText, setLiveText] = useState('')
  const [statusLabel, setStatusLabel] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [podiumSid, setPodiumSid] = useState<string | undefined>(undefined)
  const [pendingTurns, setPendingTurns] = useState<PendingTurn[]>([])

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await trpc.superagent.history.query({ threadId: THREAD_ID }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [trpc])

  // The global thread's headless session id — the only thread lookup left now
  // that the chat never switches scope.
  useEffect(() => {
    let alive = true
    void trpc.superagent.listThreads
      .query()
      .then((list) => {
        if (alive) setPodiumSid(list.find((t) => t.id === THREAD_ID)?.podiumSessionId)
      })
      .catch(() => {})
    void refreshHistory()
    return () => {
      alive = false
    }
  }, [trpc, refreshHistory])

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

  // Drop an optimistic turn once the durable history carries it.
  useEffect(() => {
    if (pendingTurns.length === 0) return
    const echoed = new Set(history.filter((m) => m.role === 'user').map((m) => m.content.trim()))
    setPendingTurns((prev) => {
      const next = prev.filter((turn) => !echoed.has(turn.text))
      return next.length === prev.length ? prev : next
    })
  }, [history, pendingTurns.length])

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setError(null)
      setRunning(true)
      setPendingTurns((prev) => [...prev, { id: `${Date.now()}:${prev.length}`, text: trimmed }])
      void trpc.superagent.sendTurn
        .mutate({ threadId: THREAD_ID, text: trimmed })
        .then((ack) => {
          if (ack?.podiumSessionId) setPodiumSid(ack.podiumSessionId)
        })
        .catch((e: unknown) => {
          setRunning(false)
          setError(e instanceof Error ? e.message : String(e))
        })
    },
    [trpc],
  )

  const interrupt = useCallback(async () => {
    try {
      await trpc.superagent.interruptTurn.mutate({ threadId: THREAD_ID })
      setRunning(false)
    } catch {
      // already stopped
    }
  }, [trpc])

  const clear = useCallback(async () => {
    try {
      await trpc.superagent.clear.mutate({ threadId: THREAD_ID })
      setHistory([])
      setPendingTurns([])
      setLiveText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [trpc])

  // The streaming answer rides the transcript as a live assistant item, so the
  // in-progress turn wears the same prose voice as the settled one.
  const items = useMemo(() => {
    const base = toTranscript(history)
    if (running && liveText.trim()) {
      base.push({ id: 'super:live', role: 'assistant', text: liveText.trim() })
    }
    return base
  }, [history, liveText, running])

  const empty = items.length === 0 && pendingTurns.length === 0 && !running

  return (
    <Screen noHeader>
      <View style={styles.column}>
        {/* Super-agent section bar — the desktop SectionBar, at bar density. */}
        <View style={[styles.bar, { paddingTop: insets.top + 7 }]}>
          <Text style={styles.glyph}>✦</Text>
          <Text style={styles.title}>Super agent</Text>
          <Text style={styles.scope}>OVERARCHING</Text>
          <View style={styles.barActions}>
            {running ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Stop turn"
                onPress={() => void interrupt()}
                hitSlop={8}
              >
                <Text style={styles.stop}>Stop</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear context — start the chat fresh"
              onPress={() => void clear()}
              hitSlop={8}
            >
              <Icon as={Eraser} size={13} color={color.textFaint} />
            </Pressable>
          </View>
        </View>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {empty ? (
            <EmptyState
              title="Hand off some work"
              body="The superagent can read your repos, file tasks, spawn worker sessions and steer them — describe what you want done."
            />
          ) : (
            <TranscriptList
              items={items}
              live={running}
              pendingTurns={pendingTurns}
              onAnswer={async () => {}}
            />
          )}
          {running && !liveText.trim() ? (
            <View style={styles.statusRow}>
              <BrailleSpinner size={11} />
              <Text style={styles.status}>{statusLabel ?? 'thinking'}</Text>
            </View>
          ) : null}
          <Composer placeholder="Delegate a task…" onSend={send} />
        </KeyboardAvoidingView>
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
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: color.bar,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairlineBar,
    paddingHorizontal: 13,
    paddingBottom: 7,
  },
  glyph: {
    color: color.accent,
    fontSize: 12,
  },
  title: {
    ...sans(600),
    color: color.text,
    fontSize: font.small,
  },
  scope: {
    ...monoLabel(8),
    color: color.textMicro,
  },
  barActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginLeft: 'auto',
  },
  stop: {
    ...sans(700),
    color: color.danger,
    fontSize: font.small,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.lg,
    paddingBottom: space.xs,
  },
  status: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.tiny,
  },
  error: {
    ...sans(400),
    color: color.danger,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingBottom: space.xs,
  },
})
