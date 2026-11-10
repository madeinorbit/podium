import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { observer } from 'mobx-react-lite'
import { StyleSheet, Text, View } from 'react-native'
import { color, font, leading, mono, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { ChevronDown } from './icons'
import { PressableScale } from './PressableScale'

/**
 * The deck's vital signs as one line ("8/14 · 1 needs you · 3 working · 2 up
 * next"), the gauge along its bottom edge, and a tap that opens the deck.
 */
export interface DeckVitals {
  done: number
  total: number
  needsYou: number
  working: number
  waiting: number
  upNext: number
}

/** One reading for the bar, the sheet header and their labels. All of it is
 *  the Full deck's own tally (the gauge's leaves and the filter counts), so
 *  the bar never disagrees with the filters it opens. */
export function deckVitals(full: FullDeck): DeckVitals | null {
  if (!full.ready) return null
  const { buckets, counts } = full
  return {
    done: buckets.done,
    total: buckets.total,
    needsYou: counts['needs-you'],
    working: buckets.working,
    waiting: buckets.waiting,
    upNext: counts['up-next'],
  }
}

/** "8/14 · 1 needs you · 3 working · 2 up next", zero parts left out. */
export function deckVitalsLabel(vitals: DeckVitals): string {
  return [
    `${vitals.done}/${vitals.total}`,
    vitals.needsYou > 0 ? `${vitals.needsYou} needs you` : null,
    vitals.working > 0 ? `${vitals.working} working` : null,
    vitals.upNext > 0 ? `${vitals.upNext} up next` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The counts line, coloured per part. Shared by the bar and the sheet. */
export function DeckVitalsLine({ vitals }: { vitals: DeckVitals }) {
  return (
    <Text style={styles.line} numberOfLines={1}>
      <Text style={styles.fraction}>{`${vitals.done}/${vitals.total}`}</Text>
      {vitals.needsYou > 0 ? (
        <Text style={styles.needs}>{`  ·  ${vitals.needsYou} needs you`}</Text>
      ) : null}
      {vitals.working > 0 ? (
        <Text style={styles.working}>{`  ·  ${vitals.working} working`}</Text>
      ) : null}
      {vitals.upNext > 0 ? <Text>{`  ·  ${vitals.upNext} up next`}</Text> : null}
    </Text>
  )
}

/** Disjoint done, working and waiting segments over a track; the rest is to do. */
export function DeckGauge({ vitals, height = 2 }: { vitals: DeckVitals; height?: number }) {
  const total = Math.max(1, vitals.total)
  const parts = [
    ['done', vitals.done, color.textFaint],
    ['working', vitals.working, color.working],
    ['waiting', vitals.waiting, color.needsYou],
  ] as const
  return (
    <View style={[styles.gauge, { height }]} aria-hidden>
      {parts
        .filter(([, count]) => count > 0)
        .map(([key, count, tone]) => (
          <View
            key={key}
            testID={`deck-gauge-${key}`}
            style={{ width: `${(Math.min(count, total) / total) * 100}%`, backgroundColor: tone }}
          />
        ))}
    </View>
  )
}

export const MissionBar = observer(function MissionBar({
  full,
  onOpen,
}: {
  full: FullDeck
  onOpen: () => void
}) {
  const vitals = deckVitals(full)
  const reading = vitals ? deckVitalsLabel(vitals) : 'Task counts are loading'
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Open flight deck, ${reading}`}
      testID="mission-bar"
      onPress={onOpen}
      scaleTo={1}
      haptic={false}
      style={({ pressed }) => [styles.bar, pressed && styles.pressed]}
    >
      <View style={styles.counts}>
        {vitals ? (
          <DeckVitalsLine vitals={vitals} />
        ) : (
          <Text style={styles.line}>Loading tasks…</Text>
        )}
      </View>
      <Icon as={ChevronDown} size={14} color={color.textFaint} />
      {vitals ? (
        <View style={styles.edge}>
          <DeckGauge vitals={vitals} />
        </View>
      ) : null}
    </PressableScale>
  )
})

const styles = StyleSheet.create({
  // Transparent: the chat scrolls under the bar and the nav bar's scroll edge
  // effect, never under an opaque strip.
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 40,
    paddingHorizontal: space.lg,
  },
  pressed: { opacity: 0.6 },
  counts: { flex: 1, minWidth: 0 },
  line: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  fraction: { ...mono(500), color: color.text, fontVariant: ['tabular-nums'] },
  needs: { color: color.needsYouText },
  working: { color: color.workingText },
  edge: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  gauge: {
    flexDirection: 'row',
    gap: 1,
    overflow: 'hidden',
    backgroundColor: color.tertiaryFill,
  },
})
