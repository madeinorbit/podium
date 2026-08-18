/**
 * HARNESS-MARK HARNESS (POD-1355). Not shipped, not part of the app.
 *
 * It draws every harness on every chip the app actually uses — 15pt census,
 * 19pt fleet tile, 20pt session chip, 22pt Now tile — plus the unknown-harness
 * fallback, so the marks can be judged at the sizes they ship at rather than at
 * a comfortable 24. Run it with `vite --config vite.harness.config.ts` from
 * apps/mobile, then `node harness/agent-mark-shoot.mjs`.
 */
import { createRoot } from 'react-dom/client'
import { StyleSheet, Text, View } from 'react-native'
import { AgentMark, kindTone, markSize } from '../src/components/AgentMark'
import { color, mono, radius, sans } from '../src/theme/theme'

const KINDS = ['claude-code', 'codex', 'grok', 'opencode', 'cursor', 'shell', 'wat'] as const

/** Every chip the app draws a harness into, with its edge in points. */
const CHIPS: { where: string; size: number }[] = [
  { where: 'spine census (collapsed strip)', size: 15 },
  { where: 'work-row fleet tile', size: 19 },
  { where: 'spine band / task sheet row', size: 20 },
  { where: 'IssueNow session tile', size: 22 },
]

const LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  shell: 'Shell',
}
const kindLabel = (kind: string) => LABELS[kind] ?? kind

function Chip({ kind, size }: { kind: string; size: number }) {
  const tone = kindTone(kind)
  return (
    <View
      style={[
        styles.chip,
        {
          width: size,
          height: size,
          borderRadius: size >= 20 ? radius.xs : 4,
          backgroundColor: tone.bg,
        },
      ]}
    >
      <AgentMark kind={kind} size={markSize(size)} ink={tone.fg} />
    </View>
  )
}

function App() {
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Harness marks — mobile</Text>
      <Text style={styles.sub}>
        the last column is an UNKNOWN harness: it keeps the initial, on purpose
      </Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.where} />
          {KINDS.map((kind) => (
            <Text key={kind} style={styles.head}>
              {kind}
            </Text>
          ))}
        </View>
        {CHIPS.map(({ where, size }) => (
          <View key={where} style={styles.row}>
            <Text style={styles.where}>
              {where} · {size}
            </Text>
            {KINDS.map((kind) => (
              <View key={kind} style={styles.cell}>
                <Chip kind={kind} size={size} />
              </View>
            ))}
          </View>
        ))}
      </View>

      <Text style={styles.sub}>the marks alone, on the page ink, 12 → 32</Text>
      <View style={[styles.card, styles.ladder]}>
        {[12, 16, 20, 24, 32].map((size) => (
          <View key={size} style={styles.ladderRow}>
            {KINDS.map((kind) => (
              <View key={kind} style={styles.cell}>
                <AgentMark kind={kind} size={size} ink={color.text} />
              </View>
            ))}
            <Text style={styles.num}>{size}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.sub}>
        the chat header — task square (the TASK's colour) then the harness mark
      </Text>
      <View style={styles.card}>
        {[
          { kind: 'claude-code', name: 'Harness brand marks port', colour: '#22c55e', ref: 'POD' },
          { kind: 'codex', name: 'Quota panel copy', colour: '#f43f5e', ref: 'POD' },
          { kind: 'shell', name: 'bun install', colour: '#3b82f6', ref: 'POD' },
        ].map((row) => (
          <View key={row.kind} style={styles.header}>
            <Text style={styles.chevron}>‹</Text>
            <View style={styles.ident}>
              <View style={[styles.idSquare, { backgroundColor: row.colour }]}>
                <Text style={styles.idPrefix}>{row.ref}</Text>
                <Text style={styles.idPrefix}>1355</Text>
              </View>
              <Chip kind={row.kind} size={18} />
            </View>
            <View>
              <Text style={styles.headerTitle}>{row.name}</Text>
              <Text style={styles.headerSub}>{kindLabel(row.kind)} · working</Text>
            </View>
          </View>
        ))}
      </View>

      <Text style={styles.sub}>a settled agent dims rather than disappears</Text>
      <View style={[styles.card, styles.dimRow]}>
        {KINDS.map((kind) => (
          <View key={kind} style={{ opacity: 0.45 }}>
            <Chip kind={kind} size={20} />
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.bg, minHeight: '100%', padding: 28, gap: 12 },
  title: { ...sans(600), color: color.text, fontSize: 18 },
  sub: { ...mono(400), color: color.label, fontSize: 10, letterSpacing: 1.2 },
  card: { backgroundColor: color.surface, borderRadius: 10, padding: 16, gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  where: { ...mono(400), color: color.textFaint, fontSize: 11, width: 210 },
  head: { ...mono(400), color: color.textMicro, fontSize: 9, width: 40, textAlign: 'center' },
  cell: { width: 40, alignItems: 'center', justifyContent: 'center' },
  chip: { alignItems: 'center', justifyContent: 'center' },
  num: { ...mono(400), color: color.textMicro, fontSize: 9, width: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  chevron: { ...sans(400), color: color.textDim, fontSize: 17, width: 12 },
  ident: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  idSquare: {
    width: 18,
    height: 18,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  idPrefix: { ...mono(600), color: 'rgba(0,0,0,0.75)', fontSize: 4.5 },
  headerTitle: { ...sans(600), color: color.text, fontSize: 15 },
  headerSub: { ...sans(400), color: color.textFaint, fontSize: 11, marginTop: 1 },
  ladder: { gap: 18 },
  ladderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dimRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
})

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
