import { relativeTime } from '@podium/client-core/focus'
import type { TranscriptItem } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { ChevronLeft, Send, SquareTerminal } from 'lucide-react-native'
import { Icon } from '../components/Icon'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { mergeTranscriptItems, transcriptDisplayText } from '../viewModels/transcript'

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter()
  const { sessionById, issueById, sendMessage, focusSessionIds, readTranscript, subscribeTranscript } = useMobileClient()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [loadingTranscript, setLoadingTranscript] = useState(true)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const session = sessionById(sessionId)
  const issue = session?.issueId ? issueById(session.issueId) : undefined
  const nextId = useMemo(() => {
    const idx = focusSessionIds.indexOf(sessionId)
    if (idx < 0 || focusSessionIds.length < 2) return null
    return focusSessionIds[(idx + 1) % focusSessionIds.length] ?? null
  }, [focusSessionIds, sessionId])

  useEffect(() => {
    let active = true
    let off: (() => void) | undefined
    setLoadingTranscript(true)
    setTranscriptError(null)
    setItems([])
    readTranscript(sessionId)
      .then((page) => {
        if (!active) return
        setItems(page.items)
        off = subscribeTranscript(sessionId, page.tail, (delta, meta) => {
          if (meta.reset) {
            void readTranscript(sessionId)
              .then((fresh) => {
                if (active) setItems(fresh.items)
              })
              .catch(() => undefined)
            return
          }
          setItems((prev) => mergeTranscriptItems(prev, delta))
        })
      })
      .catch((error: unknown) => {
        if (!active) return
        setTranscriptError(error instanceof Error ? error.message : 'Transcript is unavailable.')
      })
      .finally(() => {
        if (active) setLoadingTranscript(false)
      })
    return () => {
      active = false
      off?.()
    }
  }, [readTranscript, sessionId, subscribeTranscript])

  if (!session) {
    return (
      <View style={styles.screen}>
        <Pressable style={styles.back} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Icon as={ChevronLeft} size={20} color="#e5e7eb" />
          <Text style={styles.backText}>Focus</Text>
        </Pressable>
        <Text style={styles.missing}>Session not found.</Text>
      </View>
    )
  }

  const submit = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await sendMessage(session.sessionId, text)
      setDraft('')
    } finally {
      setSending(false)
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.topbar}>
        <Pressable style={styles.back} onPress={() => router.back()} accessibilityRole="button">
          <Icon as={ChevronLeft} size={20} color="#e5e7eb" />
          <Text style={styles.backText}>Focus</Text>
        </Pressable>
        {nextId ? (
          <Pressable style={styles.next} onPress={() => router.replace('/session/' + nextId)} accessibilityRole="button" accessibilityLabel="Next session">
            <Text style={styles.nextText}>Next</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.header}>
        <Text numberOfLines={2} style={styles.title}>
          {session.title || session.cwd}
        </Text>
        <Text style={styles.meta}>
          {session.agentKind} - {session.status} - {relativeTime(session.lastActiveAt, Date.now())}
        </Text>
        {issue ? (
          <Text numberOfLines={1} style={styles.issue}>
            #{issue.seq} {issue.title}
          </Text>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={styles.timeline}>
        {loadingTranscript ? <Text style={styles.timelineText}>Loading transcript...</Text> : null}
        {transcriptError ? <Text style={styles.warning}>{transcriptError}</Text> : null}
        {!loadingTranscript && !transcriptError && items.length === 0 ? (
          <Text style={styles.timelineText}>No transcript yet.</Text>
        ) : null}
        {items.map((item) => (
          <View key={item.cursor ?? item.id} style={item.role === 'user' ? styles.userBubble : styles.agentBubble}>
            <Text style={styles.role}>{item.role}</Text>
            <Text style={styles.timelineText}>{transcriptDisplayText(item)}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={styles.composerRow}>
        <Pressable style={styles.terminalButton} onPress={() => router.push('/session/' + sessionId + '/terminal')} accessibilityRole="button" accessibilityLabel="Open terminal">
          <Icon as={SquareTerminal} size={20} color="#d1d5db" />
        </Pressable>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Reply to this agent"
          placeholderTextColor="#64748b"
          style={styles.input}
          multiline
        />
        <Pressable style={styles.sendButton} onPress={submit} disabled={sending || !draft.trim()} accessibilityRole="button" accessibilityLabel="Send message">
          <Icon as={Send} size={18} color="#101114" />
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101114', paddingTop: 48 },
  topbar: { height: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 4 },
  backText: { color: '#e5e7eb', fontSize: 15, fontWeight: '600' },
  next: { minHeight: 36, borderRadius: 18, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: '#e5e7eb' },
  nextText: { color: '#111827', fontWeight: '700' },
  header: { paddingHorizontal: 18, paddingBottom: 12 },
  title: { color: '#f8fafc', fontSize: 22, fontWeight: '800', lineHeight: 28 },
  meta: { color: '#94a3b8', fontSize: 13, marginTop: 4 },
  issue: { color: '#93c5fd', fontSize: 13, marginTop: 4 },
  timeline: { padding: 18, gap: 12 },
  timelineText: { color: '#cbd5e1', fontSize: 15, lineHeight: 22 },
  warning: { color: '#fde68a', fontSize: 14, lineHeight: 20 },
  role: { color: '#94a3b8', fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginBottom: 4 },
  userBubble: { alignSelf: 'flex-end', maxWidth: '88%', borderRadius: 8, backgroundColor: '#1d4ed8', padding: 12 },
  agentBubble: { alignSelf: 'flex-start', maxWidth: '94%', borderRadius: 8, backgroundColor: '#181a20', padding: 12, borderWidth: 1, borderColor: '#2f333a' },
  composerRow: { padding: 12, borderTopWidth: 1, borderTopColor: '#272b33', flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  terminalButton: { width: 42, height: 42, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#20242c' },
  input: { flex: 1, maxHeight: 120, minHeight: 42, borderRadius: 8, backgroundColor: '#181a20', color: '#f8fafc', paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  sendButton: { width: 42, height: 42, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f8fafc' },
  missing: { color: '#f8fafc', fontSize: 18, padding: 18 },
})
