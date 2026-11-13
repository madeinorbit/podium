import { Host } from '@expo/ui'
import { List, RNHostView, Section } from '@expo/ui/swift-ui'
import {
  accessibilityIdentifier,
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
    <RNHostView
      matchContents={{ vertical: true }}
      modifiers={[
        listRowInsets({ leading: 0, trailing: 0, top: 0, bottom: 0 }),
        listRowSeparator('hidden'),
        listRowBackground(color.bg),
      ]}
    >
      <View style={styles.content}>{children}</View>
    </RNHostView>
  )
}

export function DeckProposals({ children }: { children: ReactNode }) {
  return (
    <Section
      modifiers={[
        listSectionMargins({ edges: 'vertical', length: 0 }),
        accessibilityIdentifier('deck-proposals'),
      ]}
    >
      {children}
    </Section>
  )
}

const styles = StyleSheet.create({ host: { flex: 1 }, content: { gap: space.md } })
