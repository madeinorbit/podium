import { useSlice } from '@podium/client-core/react'
import {
  mergeTranscriptItems,
  prependTranscriptItems,
  superagentSlice,
} from '@podium/client-core/viewmodels'
import type { SessionId, TranscriptItem } from '@podium/model'
import { Eraser } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { readTranscriptPage, useHub, useMobileStore } from '../client/hooks'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { Screen } from '../components/Screen'
import { BrailleSpinner } from '../components/StatusGlyphs'
import { type PendingTurn, TranscriptList } from '../components/TranscriptList'
import { EmptyState } from '../components/ui'
import { dropEchoedTurns, markTurnsFailed, renderedTranscript } from '../lib/superagent-transcript'
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
  const store = useMobileStore()
  const trpc = store.trpc
  const hub = useHub()
  // The signed-in user's threads, from the store's published slice — the same
  // one the desktop superagent column reads. The screen used to fetch the list
  // itself on mount AND poll it on a 5s interval, which is a second copy of
  // state the store already holds, with its own staleness.
  //
  // The slice keys on `store.superThreadId`, which is 'global' by default and
  // which this screen never changes: one thread, always global, is the phone's
  // whole superagent model (see the header). `threadById` is deliberately not
  // used — the slice exposes no lookup that takes a bare id and goes looking,
  // which is what makes another user's thread unaddressable from here
  // (doc §3.1.6 S2).
  const superagent = useSlice(superagentSlice)
  const insets = useSafeAreaInsets()
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [liveText, setLiveText] = useState('')
  const [statusLabel, setStatusLabel] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The thread's headless session: the slice's answer, until a turn's ack hands
  // back a fresher one (the FIRST turn learns its session from the ack alone).
  const [ackedSid, setAckedSid] = useState<SessionId | undefined>(undefined)
  const podiumSid = ackedSid ?? superagent.activeSessionId
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

  // Opening the tab mid-turn shows the spinner: the thread carries a
  // query-backed running flag for exactly this late-join case, because
  // headlessActivity frames are ephemeral.
  useEffect(() => {
    if (superagent.active?.turnRunning) setRunning(true)
  }, [superagent.active?.turnRunning])

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
      unsubscribe = hub.subscribeTranscript(podiumSid, since, (delta, meta) => {
        setItems((prev) => (meta.reset ? delta : mergeTranscriptItems(prev, delta)))
      })
    }
    readTranscriptPage(trpc, podiumSid)
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
  }, [trpc, hub, podiumSid])

  const loadOlder = useCallback(() => {
    const p = paging.current
    if (!podiumSid || !p.hasMore || p.loading || !p.head) return
    p.loading = true
    readTranscriptPage(trpc, podiumSid, p.head)
      .then((page) => {
        paging.current = { head: page.head, hasMore: page.hasMore, loading: false }
        setItems((prev) => prependTranscriptItems(prev, page.items))
      })
      .catch(() => {
        paging.current.loading = false
      })
  }, [trpc, podiumSid])

  // Live turn activity: the in-progress assistant text and the turn boundaries.
  // The settled reply arrives on the transcript stream, so turn-end only has to
  // put the chrome back.
  useEffect(() => {
    if (!podiumSid) return
    return hub.subscribeHeadless(podiumSid, (event) => {
      if (event.kind === 'turn-start') {
        setRunning(true)
        setLiveText('')
        setStatusLabel('starting')
      } else if (event.kind === 'turn-end') {
        setRunning(false)
        setLiveText('')
        setStatusLabel(null)
        if (event.error) {
          const reason = event.error
          setError(reason)
          // The OTHER way a turn fails (POD-344). POD-346 marks a row "not sent"
          // when the mutation is rejected — but a turn that is ACCEPTED and then
          // dies (harness crash, spawn failure) resolves that mutation, so its
          // catch never runs, and a dead turn writes no transcript for
          // dropEchoedTurns to match. Without this the row says "sending…" for
          // ever. The writer lock is released at turn-end and the server refuses
          // a second concurrent turn, so anything still pending is this turn's.
          setPendingTurns((prev) => markTurnsFailed(prev, reason) as PendingTurn[])
        }
      } else if (event.kind === 'status') {
        setStatusLabel(event.status === 'tool' ? (event.label ?? 'tool') : event.status)
      } else if ('text' in event && typeof event.text === 'string') {
        setLiveText(event.text)
        setStatusLabel(null)
      }
    })
  }, [hub, podiumSid])

  // headlessActivity frames are ephemeral, and the FIRST turn only learns its
  // session from the ack — so the subscription can attach after that turn's
  // turn-end and the spinner would never stop. The server's query-backed flag
  // is the late-joiner truth; it only ever CLEARS a stuck spinner here, so it
  // cannot race a turn that was just dispatched.
  useEffect(() => {
    if (!running) return
    // Refresh the STORE's thread list rather than querying a private copy: the
    // slice above then reports the flag, and one refetch serves every reader.
    const id = setInterval(() => void store.refreshSuperThreads().catch(() => {}), 5000)
    return () => clearInterval(id)
  }, [running, store.refreshSuperThreads])

  useEffect(() => {
    if (running && superagent.active?.turnRunning === false) {
      setRunning(false)
      setLiveText('')
      setStatusLabel(null)
    }
  }, [running, superagent.active?.turnRunning])

  // The settled conversation IS the session transcript — see superagent-transcript.ts
  // for why the legacy buffer is not folded in.
  const settled = items

  // Drop an optimistic turn once the transcript carries it.
  useEffect(() => {
    if (pendingTurns.length === 0) return
    setPendingTurns((prev) => dropEchoedTurns(prev, settled) as PendingTurn[])
  }, [settled, pendingTurns.length])

  // One dispatch, keyed by the optimistic row it owns. A rejection marks THAT
  // row "not sent" with the reason and leaves the words on screen to retry
  // (POD-346) — the old path only set a banner, which reads as "nothing
  // happened" when the reason is a stuck turn or an offline server.
  const dispatch = useCallback(
    (id: string, text: string) => {
      setRunning(true)
      void trpc.superagent.sendTurn
        .mutate({ threadId: THREAD_ID, text })
        .then((ack) => {
          if (ack?.podiumSessionId) setAckedSid(ack.podiumSessionId)
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e)
          setRunning(false)
          setPendingTurns((prev) =>
            prev.map((turn) => (turn.id === id ? { ...turn, failed: message } : turn)),
          )
        })
    },
    [trpc],
  )

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setError(null)
      // Counter, not text length: two identical messages inside one millisecond
      // would share an id, and `failed`/retry address a row BY id.
      const id = `${Date.now()}:${turnSeq.current++}`
      setPendingTurns((prev) => [...prev, { id, text: trimmed }])
      dispatch(id, trimmed)
    },
    [dispatch],
  )

  const retry = useCallback(
    (turn: PendingTurn) => {
      setPendingTurns((prev) =>
        prev.map((t) => (t.id === turn.id ? { id: t.id, text: t.text } : t)),
      )
      dispatch(turn.id, turn.text)
    },
    [dispatch],
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
      setAckedSid(undefined)
      void store.refreshSuperThreads().catch(() => {})
      setPendingTurns([])
      setLiveText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [trpc, store.refreshSuperThreads])

  // The streaming answer rides the transcript as a live assistant item, so the
  // in-progress turn wears the same prose voice as the settled one.
  const rendered = useMemo(
    () => renderedTranscript(settled, liveText, running),
    [settled, liveText, running],
  )
  const transcriptSession = podiumSid ? client.sessionById(podiumSid) : undefined

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
              collapseContext
              assetContext={
                podiumSid && transcriptSession
                  ? {
                      httpOrigin: client.serverConfig.httpOrigin,
                      sessionId: podiumSid,
                      cwd: transcriptSession.cwd,
                    }
                  : undefined
              }
              pendingTurns={pendingTurns}
              onRetryPending={retry}
              onLoadOlder={loadOlder}
              onAnswer={async (choices) => {
                if (podiumSid)
                  await trpc.sessions.answerAskUserQuestion.mutate({
                    sessionId: podiumSid,
                    choices,
                  })
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
