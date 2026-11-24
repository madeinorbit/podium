import { Host } from '@expo/ui'
import { Button } from '@expo/ui/swift-ui'
import {
  accessibilityAddTraits,
  accessibilityIdentifier,
  accessibilityLabel,
  accessibilityValue,
  buttonStyle,
  fixedSize,
  font,
  frame,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { observer } from 'mobx-react-lite'
import { Pressable, StyleSheet, Text } from 'react-native'
import { color, leading, sans, font as type } from '../theme/theme'
import { deckColor } from './deck-colors'
import { DeckContent } from './MissionDeckList'
import { doneHiddenLabel } from './mission-deck-done-label'

/** Filled when done work is shown; outlined when hidden, with native toggle traits. */
export const DoneToggle = observer(function DoneToggle({ full }: { full: FullDeck }) {
  return (
    <Host matchContents style={{ flexShrink: 0 }}>
      <Button
        label={full.showDone ? 'Hide Done' : 'Show Done'}
        systemImage={full.showDone ? 'checkmark.circle.fill' : 'checkmark.circle'}
        onPress={() => full.toggleShowDone()}
        modifiers={[
          buttonStyle('borderless'),
          font({ textStyle: 'footnote' }),
          tint(deckColor.live),
          frame({ minHeight: 44 }),
          fixedSize({ horizontal: false, vertical: true }),
          accessibilityIdentifier('deck-filter-done'),
          accessibilityLabel(`Done tasks, ${full.phoneCounts.done}`),
          accessibilityValue(full.showDone ? 'Shown' : 'Hidden'),
          accessibilityAddTraits(full.showDone ? ['isToggle', 'isSelected'] : ['isToggle']),
        ]}
      />
    </Host>
  )
})

/**
 * The quiet line at the END of the deck while done work is hidden, as Reminders
 * shows "N Completed": footnote text on the grouped ground, never a card. The
 * Show Done toggle at the top stays the control; this only says what is hidden.
 * The desktop done line supplies the count, including work in folded phases.
 */
export const DoneHidden = observer(function DoneHidden({ full }: { full: FullDeck }) {
  const done = settled(() => (full.ready ? full.phoneDoneLine : null))
  if (!done || done === LOADING) return null
  const label = doneHiddenLabel(done)
  return (
    <DeckContent>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, hidden`}
        accessibilityHint="Shows done tasks and completed phases"
        testID="deck-done-hidden"
        onPress={() => full.setShowDone(true)}
        style={({ pressed }) => [styles.footer, pressed && styles.pressed]}
      >
        <Text style={styles.label}>
          {label}
          <Text style={styles.separator}>{'  ·  '}</Text>
          <Text style={styles.show}>Show</Text>
        </Text>
      </Pressable>
    </DeckContent>
  )
})

const styles = StyleSheet.create({
  // The inset-grouped footer position: under the cards, aligned with row text.
  footer: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24, minHeight: 44 },
  pressed: { opacity: 0.5 },
  label: {
    ...sans(400),
    fontSize: type.tiny,
    lineHeight: leading(type.tiny),
    color: color.textDim,
  },
  separator: { color: color.textFaint },
  show: { color: deckColor.live },
})
