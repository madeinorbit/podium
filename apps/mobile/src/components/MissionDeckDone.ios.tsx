import { Host } from '@expo/ui'
import { Button, HStack, Spacer, Text } from '@expo/ui/swift-ui'
import {
  accessibilityAddTraits,
  accessibilityHint,
  accessibilityIdentifier,
  accessibilityLabel,
  accessibilityValue,
  buttonStyle,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { observer } from 'mobx-react-lite'
import { color } from '../theme/theme'
import { deckColor } from './deck-colors'
import { DeckGroup } from './MissionDeckList'

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

/** The desktop done line supplies the count, including work in folded phases. */
export const DoneHidden = observer(function DoneHidden({ full }: { full: FullDeck }) {
  const done = settled(() => (full.ready ? full.phoneDoneLine : null))
  if (!done || done === LOADING) return null
  const label = done.tasks
    ? `${done.tasks} done hidden`
    : `${done.phases} ${done.phases === 1 ? 'phase' : 'phases'} hidden`
  return (
    <DeckGroup testID="deck-done-footer">
      <Button
        onPress={() => full.setShowDone(true)}
        modifiers={[
          buttonStyle('borderless'),
          tint(deckColor.live),
          accessibilityIdentifier('deck-done-hidden'),
          accessibilityLabel(label),
          accessibilityHint('Show done tasks and completed phases'),
        ]}
      >
        <HStack spacing={12} modifiers={[frame({ minHeight: 44 })]}>
          <Text
            modifiers={[
              font({ textStyle: 'subheadline' }),
              foregroundStyle(color.textDim),
              fixedSize({ horizontal: false, vertical: true }),
            ]}
          >
            {label}
          </Text>
          <Spacer />
          <Text
            modifiers={[
              font({ textStyle: 'subheadline' }),
              fixedSize({ horizontal: false, vertical: true }),
            ]}
          >
            Show
          </Text>
        </HStack>
      </Button>
    </DeckGroup>
  )
})
