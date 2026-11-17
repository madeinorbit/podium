import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { observer } from 'mobx-react-lite'
import { Pressable, StyleSheet, Text } from 'react-native'
import { color, font, leading, sans, space } from '../theme/theme'
import { deckColor } from './deck-colors'
import { Icon } from './Icon'
import { CheckCircle2, Circle } from './icons'
import { DeckGroup } from './MissionDeckList'

/** Both controls write the same FullDeck state used by desktop. */
export const DoneToggle = observer(function DoneToggle({ full }: { full: FullDeck }) {
  return (
    <Pressable
      accessibilityRole="switch"
      aria-checked={full.showDone}
      accessibilityLabel={`Done tasks, ${full.counts.done}`}
      testID="deck-filter-done"
      onPress={() => full.toggleShowDone()}
      style={({ pressed }) => [styles.toggle, pressed && styles.dimmed]}
    >
      <Icon as={full.showDone ? CheckCircle2 : Circle} size={17} color={deckColor.live} />
      <Text style={styles.toggleLabel}>{full.showDone ? 'Hide Done' : 'Show Done'}</Text>
    </Pressable>
  )
})

export const DoneHidden = observer(function DoneHidden({ full }: { full: FullDeck }) {
  const done = settled(() => (full.ready ? full.doneLine : null))
  if (!done || done === LOADING) return null
  const label = done.tasks
    ? `${done.tasks} done hidden`
    : `${done.phases} ${done.phases === 1 ? 'phase' : 'phases'} hidden`
  return (
    <DeckGroup testID="deck-done-footer">
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Show done tasks and completed phases"
        testID="deck-done-hidden"
        onPress={() => full.setShowDone(true)}
        style={({ pressed }) => [styles.footer, pressed && styles.dimmed]}
      >
        <Text style={styles.footerLabel}>{label}</Text>
        <Text style={styles.toggleLabel}>Show</Text>
      </Pressable>
    </DeckGroup>
  )
})

const styles = StyleSheet.create({
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 44,
    flexShrink: 0,
  },
  toggleLabel: { ...sans(400), color: deckColor.live, fontSize: font.tiny },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 44,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  footerLabel: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small),
    flex: 1,
  },
  dimmed: { opacity: 0.5 },
})
