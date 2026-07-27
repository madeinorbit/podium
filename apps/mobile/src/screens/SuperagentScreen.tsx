import { mergeTranscriptItems, prependTranscriptItems } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/protocol'
import { Eraser } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileClient } from '../client/MobileClientProvider'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { Screen } from '../components/Screen'
import { BrailleSpinner } from '../components/StatusGlyphs'
import { type PendingTurn, TranscriptList } from '../components/TranscriptList'
import { EmptyState } from '../components/ui'
import { dropEchoedTurns, dropFailedTurns, renderedTranscript } from '../lib/superagent-transcript'
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
 *    bespoke chat vocabulary — and, since POD-344, over the same SOURCE: the
 *    thread's headless session transcript, and only that. `superagent.history`
 *    is the frozen legacy buffer, so a screen built on it rendered neither the
 *    turn it just sent nor the reply — the phone hung on "sending" forever.
 *    The desktop reads none of it and neither does this; see
 *    ../lib/superagent-transcript for why folding it back in is a trap.
 *  - Laid out like every other tab: safe-area header, one scroller, composer
 *    docked directly above the tab bar — no hand-tuned lift leaving dead space.
 */
const THREAD_ID = 'global'

export function SuperagentScreen() {
  const client = useMobileClient()
  const { trpc, subscribeHeadless, readTranscript, subscribeTranscript, answerQuestion } = client
  const insets = useSafeAreaInsets()
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [liveText, setLiveText] = useState('')
  const [statusLabel, setStatusLabel] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [podiumSid, setPodiumSid] = useState<string | undefined>(undefined)
  const [pendingTurns, setPendingTurns] = useState<PendingTurn[]>([])
  // Monotonic per-mount counter behind each optimistic row's id. Date.now()
  // alone collides when two sends land in the same millisecond.
  const turnSeq = useRef(0)
  // Scroll-back paging state. Refs, not state: paging must not retrigger the
  // load/subscribe effect, and onLoadOlder can fire in bursts.
  const paging = useRef<{ head?: string; hasMore: boolean; loading: boolean }>({
    hasMore: false,
    loading: false,
  })

  // The global thread's headless session id — the transcript source — plus the
  // query-backed running flag, so opening the tab mid-turn shows the spinner.
  useEffect(() => {
    let alive = true
    void trpc.superagent.listThreads
      .query()
      .then((list) => {
        if (!alive) return
        const thread = list.find((t) => t.id === THREAD_ID)
        setPodiumSid(thread?.podiumSessionId)
        if (thread?.turnRunning) setRunning(true)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [trpc])

  // The conversation itself, read and streamed from the thread's headless
  // session exactly as SessionScreen does for a normal chat.
  useEffect(() => {
    if (!podiumSid) return
    let alive = true
    let unsubscribe: (() => void) | null = null
    setItems([])
    paging.current = { hasMore: false, loading: false }
    const attach = (since: string | undefined) => {
      if (!alive) return
      unsubscribe = subscribeTranscript(podiumSid, since, (delta, meta) => {
        setItems((prev) => (meta.reset ? delta : mergeTranscriptItems(prev, delta)))
      })
    }
    readTranscript(podiumSid)
      .then((page) => {
        if (!alive) return
        setItems(page.items)
        paging.current = { head: page.head, hasMore: page.hasMore, loading: false }
        attach(page.tail)
      })
      .catch(() => attach(undefined))
    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [readTranscript, subscribeTranscript, podiumSid])

  const loadOlder = useCallback(() => {
    const p = paging.current
    if (!podiumSid || !p.hasMore || p.loading || !p.head) return
    p.loading = true
    readTranscript(podiumSid, p.head)
      .then((page) => {
        paging.current = { head: page.head, hasMore: page.hasMore, loading: false }
        setItems((prev) => prependTranscriptItems(prev, page.items))
      })
      .catch(() => {
        paging.current.loading = false
      })
  }, [readTranscript, podiumSid])

  // Live turn activity: the in-progress assistant text and the turn boundaries.
  // The settled reply arrives on the transcript stream, so turn-end only has to
  // put the chrome back.
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
        if (event.error) {
          setError(event.error)
          // A turn that DIED after dispatch (harness crash, spawn failure) may
          // have written no transcript at all, so its optimistic row would sit
          // on "sending…" forever too — the same POD-344 symptom one step
          // later. The thread's writer lock is released here, so anything still
          // pending belongs to the turn that just failed.
          setPendingTurns((prev) => dropFailedTurns(prev) as PendingTurn[])
        }
      } else if (event.kind === 'status') {
        setStatusLabel(event.status === 'tool' ? (event.label ?? 'tool') : event.status)
      } else if ('text' in event && typeof event.text === 'string') {
        setLiveText(event.text)
        setStatusLabel(null)
      }
    })
  }, [subscribeHeadless, podiumSid])

  // headlessActivity frames are ephemeral, and the FIRST turn only learns its
  // session from the ack — so the subscription can attach after that turn's
  // turn-end and the spinner would never stop. The server's query-backed flag
  // is the late-joiner truth; it only ever CLEARS a stuck spinner here, so it
  // cannot race a turn that was just dispatched.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      void trpc.superagent.listThreads
        .query()
        .then((list) => {
          const thread = list.find((t) => t.id === THREAD_ID)
          if (thread && !thread.turnRunning) {
            setRunning(false)
            setLiveText('')
            setStatusLabel(null)
          }
        })
        .catch(() => {})
    }, 5000)
    return () => clearInterval(id)
  }, [running, trpc])

  // The settled conversation IS the session transcript — see superagent-transcript.ts
  // for why the legacy buffer is not folded in.
  const settled = items

  // Drop an optimistic turn once the transcript carries it.
  useEffect(() => {
    if (pendingTurns.length === 0) return
    setPendingTurns((prev) => dropEchoedTurns(prev, settled) as PendingTurn[])
  }, [settled, pendingTurns.length])

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setError(null)
      setRunning(true)
      // Minted up front, not inside the updater: the rejection path below needs
      // to name exactly this row to retract it.
      const turnId = `${Date.now()}:${turnSeq.current++}`
      setPendingTurns((prev) => [...prev, { id: turnId, text: trimmed }])
      void trpc.superagent.sendTurn
        .mutate({ threadId: THREAD_ID, text: trimmed })
        .then((ack) => {
          if (ack?.podiumSessionId) setPodiumSid(ack.podiumSessionId)
        })
        .catch((e: unknown) => {
          setRunning(false)
          setError(e instanceof Error ? e.message : String(e))
          // The turn never ran, so no transcript will ever echo it: retract the
          // optimistic row here or it reads "sending…" until remount (POD-344).
          setPendingTurns((prev) => dropFailedTurns(prev, turnId) as PendingTurn[])
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
      // The server drops the thread's harness+headless binding, so the old
      // session's transcript is no longer this thread's: forget it and let the
      // next turn's ack hand back a fresh session.
      setItems([])
      setPodiumSid(undefined)
      setPendingTurns([])
      setLiveText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [trpc])

  // The streaming answer rides the transcript as a live assistant item, so the
  // in-progress turn wears the same prose voice as the settled one.
  const rendered = useMemo(
    () => renderedTranscript(settled, liveText, running),
    [settled, liveText, running],
  )

  const empty = rendered.length === 0 && pendingTurns.length === 0 && !running

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
              fill
              title="Hand off some work"
              body="The superagent can read your repos, file tasks, spawn worker sessions and steer them — describe what you want done."
            />
          ) : (
            <TranscriptList
              items={rendered}
              live={running}
              pendingTurns={pendingTurns}
              onLoadOlder={loadOlder}
              onAnswer={async (choices) => {
                if (podiumSid) await answerQuestion(podiumSid, choices)
              }}
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
