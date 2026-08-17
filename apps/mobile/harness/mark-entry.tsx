/**
 * WORKING-MARK HARNESS (POD-1259). Not shipped, not part of the app.
 *
 * It renders the new mark beside the spinner it replaces, at every size the
 * app actually asks for, so the optical sizing can be judged rather than
 * guessed — the old `size` was a FONT size whose braille cell fills roughly
 * 0.7em, the new one is the cell's own height, so the numbers could not simply
 * carry over. Run it with `vite --config vite.harness.config.ts` from
 * apps/mobile.
 */
import { createRoot } from 'react-dom/client'
import { StyleSheet, Text, View } from 'react-native'
import { WorkingMark } from '../src/components/WorkingMark'
import { color, mono, sans } from '../src/theme/theme'
import { BrailleSpinner as OldBrailleSpinner } from './OldBrailleSpinner'

/** Every place the app shows "an agent is computing", old size → new size. */
const SITES: { where: string; was: number; now: number }[] = [
  { where: 'IdSquare corner badge', was: 7, now: 9 },
  { where: 'spine issue row', was: 9, now: 11 },
  { where: 'WorkScreen row', was: 9, now: 11 },
  { where: 'MissionScreen deck bar', was: 9, now: 11 },
  { where: 'IssueNow session row', was: 10, now: 12 },
  { where: 'SessionCard status', was: 11, now: 12 },
  { where: 'spine band', was: 12, now: 13 },
  { where: 'SuperagentScreen status', was: 11, now: 13 },
]

function Row({ where, was, now }: { where: string; was: number; now: number }) {
  return (
    <View style={styles.row}>
      <Text style={styles.where}>{where}</Text>
      <View style={styles.cell}>
        <OldBrailleSpinner size={was} />
      </View>
      <Text style={styles.num}>{was}</Text>
      <View style={styles.cell}>
        <WorkingMark size={now} />
      </View>
      <Text style={styles.num}>{now}</Text>
      {/* The same mark on the dark disc the ID square badges it into. */}
      <View style={styles.badge}>
        <WorkingMark size={now} />
      </View>
    </View>
  )
}

function App() {
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Working mark — mobile</Text>
      <Text style={styles.sub}>old spinner · new mark · new mark on the ID-square badge disc</Text>
      <View style={styles.card}>
        {SITES.map((s) => (
          <Row key={s.where} {...s} />
        ))}
      </View>
      <Text style={styles.sub}>end of the feed — the tail, where it is stared at</Text>
      <View style={styles.card}>
        <View style={styles.tail}>
          <WorkingMark size={18} label={null} />
          <Text style={styles.tailLabel}>Working</Text>
          <Text style={styles.tailElapsed}>1:12</Text>
          <View style={styles.tailRule} />
        </View>
        <View style={styles.tail}>
          <Text style={styles.tailWas}>⠿</Text>
          <Text style={styles.tailLabel}>Working</Text>
          <Text style={styles.tailElapsed}>1:12</Text>
          <View style={styles.tailRule} />
        </View>
      </View>

      <Text style={styles.sub}>the ladder, 7 → 24, on one baseline</Text>
      <View style={[styles.card, styles.ladder]}>
        {[7, 9, 11, 12, 13, 15, 18, 24].map((size) => (
          <View key={size} style={styles.ladderCell}>
            <WorkingMark size={size} />
            <Text style={styles.num}>{size}</Text>
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
  card: {
    backgroundColor: color.surface,
    borderRadius: 10,
    padding: 16,
    gap: 14,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  where: { ...mono(400), color: color.textFaint, fontSize: 11, width: 190 },
  cell: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 4,
  },
  num: { ...mono(400), color: color.textMicro, fontSize: 9, width: 16 },
  badge: {
    minWidth: 13,
    height: 13,
    borderRadius: 999,
    backgroundColor: '#0c1f18',
    borderWidth: 1,
    borderColor: color.working,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 1,
  },
  tail: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  tailWas: { ...mono(500), color: color.working, fontSize: 13 },
  tailLabel: { ...sans(500), color: color.textDim, fontSize: 13 },
  tailElapsed: { ...mono(400), color: color.textMicro, fontSize: 11 },
  tailRule: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.06)' },
  ladder: { flexDirection: 'row', alignItems: 'flex-end', gap: 22 },
  ladderCell: { alignItems: 'center', gap: 6 },
})

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
