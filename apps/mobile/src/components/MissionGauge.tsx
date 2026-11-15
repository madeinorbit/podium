import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { StyleSheet, Text, View } from 'react-native'
import { color, font, leading, sans } from '../theme/theme'
import { useLiveInk } from '../theme/use-live-ink'
import { deckColor } from './deck-colors'

export interface DeckVitals {
  done: number
  total: number
  needsYou: number
  working: number
  waiting: number
  todo: number
  upNext: number
}

/** Shared FullDeck execution buckets and attention counts, independent of visible filters. */
export function deckVitals(full: FullDeck): DeckVitals | null {
  if (!full.ready) return null
  const { buckets, counts } = full
  return {
    done: buckets.done,
    total: buckets.total,
    needsYou: counts['needs-you'],
    working: buckets.working,
    waiting: buckets.waiting,
    todo: buckets.todo,
    upNext: counts['up-next'],
  }
}

/** The full deck's counts line, coloured per part. Chrome that cannot grow
 * (the chat's pinned bar) passes one line and a text-size cap. */
export function DeckVitalsLine({
  vitals,
  numberOfLines,
  maxFontSizeMultiplier,
}: {
  vitals: DeckVitals
  numberOfLines?: number
  maxFontSizeMultiplier?: number
}) {
  const lineInk = useLiveInk(color.textDim)
  const fractionInk = useLiveInk(color.text)
  const needsInk = useLiveInk(deckColor.needsYou)
  const workingInk = useLiveInk(deckColor.working)
  return (
    <Text
      style={lineInk === color.textDim ? styles.line : [styles.line, { color: lineInk }]}
      numberOfLines={numberOfLines}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
    >
      <Text
        style={
          fractionInk === color.text ? styles.fraction : [styles.fraction, { color: fractionInk }]
        }
      >{`${vitals.done}/${vitals.total}`}</Text>
      {vitals.needsYou > 0 ? (
        <Text
          style={
            needsInk === deckColor.needsYou ? styles.needs : [styles.needs, { color: needsInk }]
          }
        >{`  ·  ${vitals.needsYou} needs you`}</Text>
      ) : null}
      {vitals.working > 0 ? (
        <Text
          style={
            workingInk === deckColor.working
              ? styles.working
              : [styles.working, { color: workingInk }]
          }
        >{`  ·  ${vitals.working} working`}</Text>
      ) : null}
      {vitals.upNext > 0 ? <Text>{`  ·  ${vitals.upNext} up next`}</Text> : null}
    </Text>
  )
}

/** Disjoint done, working and waiting segments over a track; the rest is to do. */
export function DeckGauge({ vitals, height = 8 }: { vitals: DeckVitals; height?: number }) {
  const total = Math.max(1, vitals.total)
  const parts = [
    ['done', vitals.done, deckColor.gaugeDone],
    ['working', vitals.working, deckColor.gaugeWorking],
    ['waiting', vitals.waiting, deckColor.gaugeWaiting],
    ['todo', vitals.todo, deckColor.gaugeTodo],
  ] as const
  return (
    <View
      // Desktop keeps a neutral track when nothing is counted yet.
      style={[
        styles.gauge,
        { height },
        vitals.total === 0 && { backgroundColor: deckColor.gaugeTodo },
      ]}
      testID="deck-gauge"
      aria-hidden
    >
      {parts
        .filter(([, count]) => count > 0)
        .map(([key, count, tone]) => (
          <View
            key={key}
            testID={`deck-gauge-${key}`}
            style={{ flex: count / total, minWidth: 2, backgroundColor: tone }}
          />
        ))}
    </View>
  )
}

const styles = StyleSheet.create({
  line: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  fraction: { ...sans(600), color: color.text, fontVariant: ['tabular-nums'] },
  needs: { color: deckColor.needsYou },
  working: { color: deckColor.working },
  gauge: {
    flexDirection: 'row',
    gap: 2,
    borderRadius: 0,
    flexShrink: 0,
    overflow: 'hidden',
    backgroundColor: color.clear,
  },
})
