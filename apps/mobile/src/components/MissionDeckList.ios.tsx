import { Host } from '@expo/ui'
import { List, RNHostView, Section, VStack } from '@expo/ui/swift-ui'
import {
  Animation,
  accessibilityIdentifier,
  animation,
  background,
  frame,
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
          background(color.groupedBg),
          accessibilityIdentifier('mission-deck'),
        ]}
      >
        {children}
      </List>
    </Host>
  )
}

/** Non-card content is a section header so List never rounds or clips its gauge. */
export function DeckContent({ children }: { children: ReactNode }) {
  return (
    <Section header={<Content>{children}</Content>} modifiers={sectionMargins}>
      {null}
    </Section>
  )
}

function Content({ children }: { children: ReactNode }) {
  return (
    <RNHostView matchContents={{ vertical: true }}>
      <View collapsable={false} style={styles.content}>
        {children}
      </View>
    </RNHostView>
  )
}

export function DeckGroup({
  children,
  header,
  testID,
}: {
  children: ReactNode
  header?: ReactNode
  testID: string
}) {
  return (
    <Section
      header={header ? <Content>{header}</Content> : undefined}
      modifiers={[...sectionMargins, accessibilityIdentifier(testID)]}
    >
      {children}
    </Section>
  )
}

/** Each accepted task/seat has its own non-collapsable Yoga measurement root.
 * A mission-sized RNHostView cell is recycled/clipped as one UIKit list item.
 * Keeping rows separate also lets SwiftUI measure catch-up inserts independently. */
export function DeckRow({ children }: { children: ReactNode }) {
  return (
    <VStack
      modifiers={[
        frame({ maxWidth: Infinity, alignment: 'leading' }),
        listRowInsets({ leading: 0, trailing: 0, top: 0, bottom: 0 }),
        listRowSeparator('hidden'),
        listRowBackground(color.groupedCard),
      ]}
    >
      <RNHostView matchContents={{ vertical: true }}>
        <View collapsable={false}>{children}</View>
      </RNHostView>
    </VStack>
  )
}

const sectionMargins = [listSectionMargins({ edges: 'vertical', length: 0 })]

export function DeckProposals({
  children,
  ids,
  header,
}: {
  children: ReactNode
  ids: readonly string[]
  header?: ReactNode
}) {
  const reduceMotion = useReduceMotion()
  const revision = listOrderRevision([{ key: 'proposals', folded: false, ids }])
  return (
    <Section
      header={header ? <Content>{header}</Content> : undefined}
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

const styles = StyleSheet.create({
  host: { flex: 1 },
  content: { gap: space.md, paddingVertical: space.sm },
})
