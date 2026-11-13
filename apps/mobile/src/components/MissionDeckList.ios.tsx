import { Host } from '@expo/ui'
import { List, RNHostView, Section, VStack } from '@expo/ui/swift-ui'
import {
  Animation,
  accessibilityIdentifier,
  animation,
  background,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  listSectionMargins,
  listSectionSpacing,
  listStyle,
  scrollContentBackground,
} from '@expo/ui/swift-ui/modifiers'
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { listOrderRevision } from '../lib/list-order-revision'
import { color, space } from '../theme/theme'

/** One native list owns scrolling and proposal swipe gestures. The deck reads FullDeck unchanged. */
export function MissionDeckList({ children }: { children: ReactNode }) {
  return (
    <Host style={styles.host}>
      <List
        modifiers={[
          listStyle('insetGrouped'),
          listSectionSpacing(0),
          scrollContentBackground('hidden'),
          background(color.bg),
          accessibilityIdentifier('mission-deck'),
        ]}
      >
        {children}
      </List>
    </Host>
  )
}

export function DeckContent({ children }: { children: ReactNode }) {
  return (
    <VStack
      modifiers={[
        listRowInsets({ leading: 0, trailing: 0, top: 0, bottom: 0 }),
        listRowSeparator('hidden'),
        listRowBackground(color.bg),
      ]}
    >
      <RNHostView matchContents={{ vertical: true }}>
        <View style={styles.content}>{children}</View>
      </RNHostView>
    </VStack>
  )
}

export function DeckProposals({ children, ids }: { children: ReactNode; ids: readonly string[] }) {
  const reduceMotion = useReduceMotion()
  const revision = listOrderRevision([{ key: 'proposals', folded: false, ids }])
  return (
    <Section
      modifiers={[
        listSectionMargins({ edges: 'vertical', length: 0 }),
        accessibilityIdentifier('deck-proposals'),
        // Keep this section mounted, even when its last receipt expires. Only
        // its row changes animate; animating the List would move the nav bar.
        ...(reduceMotion ? [] : [animation(Animation.default, revision)]),
      ]}
    >
      {children}
    </Section>
  )
}

const styles = StyleSheet.create({ host: { flex: 1 }, content: { gap: space.md } })
