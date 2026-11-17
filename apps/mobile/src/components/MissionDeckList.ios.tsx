import { Host } from '@expo/ui'
import { Group, List, RNHostView, Section, VStack } from '@expo/ui/swift-ui'
import {
  Animation,
  accessibilityIdentifier,
  animation,
  background,
  frame,
  listRowInsets,
  listSectionMargins,
  listSectionSpacing,
  listStyle,
  scrollContentBackground,
} from '@expo/ui/swift-ui/modifiers'
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { listOrderRevision } from '../lib/list-order-revision'
import { color } from '../theme/theme'

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

/** Header content takes no SwiftUI header insets: the deck sets its own 4pt rhythm. */
function Content({ children }: { children: ReactNode }) {
  return (
    <VStack modifiers={headerInsets}>
      <RNHostView matchContents={{ vertical: true }}>
        <View collapsable={false} style={styles.content}>
          {children}
        </View>
      </RNHostView>
    </VStack>
  )
}

const headerInsets = [
  frame({ maxWidth: Infinity, alignment: 'leading' }),
  listRowInsets({ leading: 0, trailing: 0, top: 0, bottom: 0 }),
]

export function DeckGroup({
  children,
  header,
  heading,
}: {
  children: ReactNode
  /** React content above the card (the deck head, a gap), hosted as the header. */
  header?: ReactNode
  /** A native heading row (DeckPhaseHeading): its own quiet row above the card. */
  heading?: ReactNode
  /** Names the group on web; native rows carry their own identifiers. */
  testID: string
}) {
  return (
    <>
      {heading ? <Section modifiers={sectionMargins}>{heading}</Section> : null}
      {/* No Section identifier: SwiftUI stamps it on every row in the Section,
          over each row's own (deck-task, deck-agent, deck-seat). */}
      <Section header={header ? <Content>{header}</Content> : undefined} modifiers={sectionMargins}>
        {children}
      </Section>
    </>
  )
}

/** Rows are native List rows (MissionDeckRows.ios) that set their own row
 * traits. SwiftUI sizes them from their own text, so heights follow the cell's
 * width, Dynamic Type and live updates, and recycling never strands a hosted
 * React view in another cell [POD-2529]. */
export function DeckRow({ children }: { children: ReactNode }) {
  return children
}

/** Scope native insert/delete motion to accepted rows, keeping the gauge and bars still. */
export function DeckTasks({ children, ids }: { children: ReactNode; ids: readonly string[] }) {
  const reduceMotion = useReduceMotion()
  const revision = listOrderRevision([{ key: 'tasks', folded: false, ids }])
  return (
    <Group modifiers={reduceMotion ? [] : [animation(Animation.default, revision)]}>
      {children}
    </Group>
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
        // No Section identifier (as DeckGroup): SwiftUI would stamp it over
        // every proposal row's own (deck-proposal, deck-proposal-slot-<id>).
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
  // Each header's own content sets its spacing (the deck's 4pt rhythm).
  content: { width: '100%' },
})
