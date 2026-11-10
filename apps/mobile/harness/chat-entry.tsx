/**
 * CHAT LAYOUT HARNESS (POD-2380). Not shipped, not part of the app.
 *
 * Renders the real TranscriptList and Composer at phone width with a fixture
 * close to board Chat: prose, tool folds, a note, an opened question with Reply
 * and the one live turn line, then the composer with the reply line. The model
 * chip is drawn by a native SwiftUI menu on iOS and reads the store, so here it
 * is a static sketch; check it in the simulator.
 *
 *   ?reply=1   the composer replying to the asker (board ChatReply)
 */
import type { TranscriptItem } from '@podium/model'
import { createRoot } from 'react-dom/client'
import { StyleSheet, Text, View } from 'react-native'
import { Composer } from '../src/components/Composer'
import { ComposerReplyHeader } from '../src/components/ComposerReplyHeader'
import { Icon } from '../src/components/Icon'
import { ChevronDown } from '../src/components/icons'
import { TranscriptList } from '../src/components/TranscriptList'
import { color, font, mono } from '../src/theme/theme'

const params = new URLSearchParams(window.location.search)
const replying = params.get('reply') === '1'
const t = (m: number, s = 0) => new Date(Date.UTC(2026, 10, 10, 10, m, s)).toISOString()
const now = new Date(Date.now() - 42_000).toISOString()

const items: TranscriptItem[] = [
  {
    id: 'p1',
    role: 'assistant',
    ts: t(0),
    text: 'The strategy report now cites the corrected corpus. Two community sources are still marked as unverified.',
  },
  {
    id: 'b1',
    role: 'tool',
    ts: t(1),
    toolName: 'Bash',
    toolUseId: 'use-b1',
    toolInput: 'bun scripts/build-corpus.ts',
    durationMs: 120_000,
    text: '',
  },
  {
    id: 'b2',
    role: 'tool',
    ts: t(3),
    toolName: 'Read',
    toolUseId: 'use-b2',
    toolInput: '/repo/chart.ts',
    durationMs: 75_000,
    text: '',
  },
  // The harness's own summary of those two calls (systemKind 'tool-summary'):
  // the fold reads it instead of the subjects; the run below has none.
  {
    id: 's1',
    role: 'system',
    systemKind: 'tool-summary',
    ts: t(4),
    text: 'Rebuilt the corpus and regenerated the chart',
    summarizes: ['use-b1', 'use-b2'],
  },
  {
    id: 'u1',
    role: 'user',
    ts: t(5),
    text: 'Why did everything land in Q3? Is that real demand or wrong data?',
  },
  {
    id: 'b3',
    role: 'tool',
    ts: t(6),
    toolName: 'Grep',
    toolInput: 'published_at',
    toolResult: '12 matches',
    durationMs: 48_000,
    text: '',
  },
  {
    id: 'p2',
    role: 'assistant',
    ts: t(7),
    text: 'The Q3 spike is a collection artifact. The retained X records were published in one batch, so the chart counted the upload date.',
  },
  {
    id: 'n1',
    role: 'user',
    ts: t(8),
    text: '[podium message msg_n · from issue:POD-1906 · to issue:POD-1879]\nStopped all writes in main. The validated CSV is ready to move.\n[end podium message msg_n]',
  },
  {
    id: 'q1',
    role: 'user',
    ts: t(9),
    text: '[podium message msg_q · from issue:POD-1906 · to operator]\nShould the validated CSV stay in this worktree or move to the report?\n[this is a question: reply with podium mail reply msg_q]\n[end podium message msg_q]',
  },
  {
    id: 'p3',
    role: 'assistant',
    ts: t(10),
    text: 'The revised report stays in review. The biased Q3 chart is gone and both corpora are documented.',
  },
  {
    id: 'b4',
    role: 'tool',
    ts: now,
    toolName: 'Read',
    toolInput: '/repo/transcript-graph.ts',
    text: '',
  },
]

const mailReply = {
  active: replying,
  target: replying ? { id: 'msg_q', from: 'issue:POD-1906' } : null,
  start: () => {},
  load: async () => {},
  message: () => undefined,
}

function Chip() {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} numberOfLines={1}>
        GPT-5.6-Sol · Extra high
      </Text>
      <Icon as={ChevronDown} size={11} color={color.textDim} />
    </View>
  )
}

function App() {
  return (
    <View style={styles.phone}>
      <TranscriptList
        items={items}
        live
        transcriptQuestion={null}
        onAnswer={async () => {}}
        mailReply={mailReply as never}
        onQuote={() => {}}
        tail={{ label: 'Working', tone: 'working', since: now }}
        bottomInset={140}
      />
      <View style={styles.composer}>
        <Composer
          placeholder={replying ? 'Reply to POD-1906' : 'Message'}
          onSend={() => {}}
          value={replying ? 'Move it to the report' : ''}
          onChangeText={() => {}}
          header={
            replying ? <ComposerReplyHeader asker="POD-1906" onCancel={() => {}} /> : undefined
          }
          leading={<Chip />}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  phone: { width: 402, height: 874, backgroundColor: color.bg, overflow: 'hidden' },
  composer: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 32 },
  chipText: { ...mono(400), color: color.textDim, fontSize: font.micro, lineHeight: 16 },
})

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
