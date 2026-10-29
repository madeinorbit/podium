import { missionCrewLabel, missionProgressLabel } from '@podium/client-core/values'
import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { observer } from 'mobx-react-lite'
import { StyleSheet, Text, View } from 'react-native'
import { alpha } from '../theme/mix'
import { color, font, leading, mono, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { ChevronRight } from './icons'
import { PressableScale } from './PressableScale'
import { WorkingMark } from './WorkingMark'

/** The collapsed mission reads the same accepted task counts as the full deck. */
export const MissionBar = observer(function MissionBar({
  full,
  live,
  working,
  attention,
  onOpen,
}: {
  full: FullDeck
  live: number
  working: number
  attention: number
  onOpen: () => void
}) {
  const counts = full.ready ? full.buckets : null
  const bands = counts
    ? ([
        ['done', 'done', counts.done, color.textDim],
        ['working', 'working', counts.working, color.workingText],
        ['waiting', 'waiting', counts.waiting, color.label],
        ['todo', 'to do', counts.todo, color.border],
      ] as const)
    : []
  const crew = missionCrewLabel(live, working)
  const reading = counts ? missionProgressLabel(counts) : 'Task counts are loading'
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Mission details, ${reading}${attention > 0 ? `, ${attention} asking` : ''}`}
      accessibilityHint={`Agents: ${crew}`}
      onPress={onOpen}
      scaleTo={0.995}
      haptic={false}
      style={({ pressed }) => [styles.bar, pressed && styles.pressed]}
    >
      <View style={styles.counts}>
        {bands
          .filter(([, , count]) => count > 0)
          .map(([state, word, count]) => (
            <View key={state} style={styles.key}>
              {state === 'working' && full.computing ? <WorkingMark size={11} /> : null}
              <Text style={styles.caption}>
                <Text style={[styles.number, state === 'working' && styles.working]}>{count}</Text>{' '}
                {word}
              </Text>
            </View>
          ))}
        {counts?.total === 0 ? <Text style={styles.caption}>0 tasks</Text> : null}
        {!counts ? <Text style={styles.caption}>Loading tasks…</Text> : null}
        {attention > 0 ? <Text style={styles.ask}>{attention} asking</Text> : null}
      </View>
      <Icon as={ChevronRight} size={16} color={color.textDim} />
      <View style={styles.meter} aria-hidden>
        {bands
          .filter(([, , count]) => count > 0)
          .map(([state, , count, tone]) => (
            <View
              key={state}
              testID={`mission-bar-${state}`}
              style={[styles.segment, { flexGrow: count, backgroundColor: tone }]}
            />
          ))}
      </View>
    </PressableScale>
  )
})

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 44,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.bar,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairlineBar,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  pressed: { opacity: 0.85 },
  counts: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: space.lg,
    rowGap: space.xs,
  },
  key: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  caption: {
    ...sans(),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  number: { ...mono(600), color: color.body, fontVariant: ['tabular-nums'] },
  working: { color: color.workingText },
  ask: {
    ...sans(600),
    color: color.needsYouText,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  meter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    height: 2,
    backgroundColor: alpha(color.border, 0.6),
  },
  segment: { height: '100%', flexBasis: 0 },
})
